import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createTemplateItem,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * SYS-1 (system-review-2026-07-27, Critical) — the completion cascade
 * (PR-055/056) was built in slice 5 "for slice 7's verify transaction to
 * call" and slice 7 never called it: `schedule_rule.next_due_on` was advanced
 * by NOTHING, so after the first generated job per asset/frequency completed,
 * no successor PM job could ever be generated — the recurring-maintenance
 * loop died after one cycle.
 *
 * This spec proves the WHOLE loop end to end, through real HTTP + the real
 * scheduler: generate → assign → record → submit → verify(stage 1) →
 * verify(stage 2, archives) → `next_due_on` advanced → THE NEXT SCHEDULER
 * TICK GENERATES THE SUCCESSOR JOB. That last assertion is the point — "the
 * cascade was called" is not the finish line, "the next job exists" is.
 */
describe('Completion cascade wiring — verify advances the schedule and the successor job generates (SYS-1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  async function makeSchedulableAsset(frequencies: Array<'M1' | 'M3' | 'M6' | 'Y'>) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    // Lead time 90 days so a next_due_on one month out is INSIDE the
    // generation window on the second tick — the successor's existence is
    // then decided purely by whether the cascade advanced the rule.
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
      {
        leadTimeDays: 90,
      },
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const itemIds: string[] = [];
    for (const frequency of frequencies) {
      itemIds.push(await createTemplateItem(revisionId, frequency));
    }
    return { assetId, revisionId, itemIds };
  }

  async function makeUsers() {
    const tlId = await createUser('tl');
    await grantRole(tlId, 'TEAM_LEADER');
    const engId = await createUser('eng');
    await grantRole(engId, 'ENGINEER');
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = ANY($1::uuid[])`,
      [[tlId, engId]],
    );
    return {
      tlToken: await mintAccessToken(app, tlId, ['TEAM_LEADER']),
      engToken: await mintAccessToken(app, engId, ['ENGINEER']),
      maintainerId,
      maintainerToken: await mintAccessToken(app, maintainerId, ['MAINTAINER']),
    };
  }

  /** Drives one job through assign → record all items → submit → 2-stage verify, via real HTTP. */
  async function completeJob(
    jobId: string,
    itemIds: string[],
    users: Awaited<ReturnType<typeof makeUsers>>,
  ) {
    const server = app.getHttpServer();
    await request(server)
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(users.tlToken))
      .send({ assigneeId: users.maintainerId })
      .expect(200);
    for (const templateItemId of itemIds) {
      await request(server)
        .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
        .set(...authHeader(users.maintainerToken))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(200);
    }
    await request(server)
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(users.maintainerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    const final = await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(final.body.status).toBe('ARCHIVED');
  }

  it('PR-055/056 e2e: generate → complete → next_due_on advances → the NEXT tick generates the successor job', async () => {
    const { assetId, itemIds } = await makeSchedulableAsset(['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    // Tick 1 — bootstrap creates the M1 rule (anchor = today) and generates
    // the first job.
    const first = await scheduler.run();
    expect(first.ran && first.generated).toBe(1);
    const jobs1 = await adminPool.query(
      `SELECT id, due_on FROM "job" WHERE asset_id = $1 ORDER BY due_on`,
      [assetId],
    );
    expect(jobs1.rowCount).toBe(1);
    const firstJobId = jobs1.rows[0].id as string;
    const firstDueOn = jobs1.rows[0].due_on as Date;

    // Before the fix, re-ticking here forever reported "exists" and the
    // schedule never moved. Sanity-pin that a tick WITHOUT completion
    // generates nothing new:
    const idle = await scheduler.run();
    expect(idle.ran && idle.generated).toBe(0);

    await completeJob(firstJobId, itemIds, users);

    // The cascade must have advanced the rule: last_completed_on = the
    // verify date (today), next_due_on = +1 month (ADR-009 rolling, not
    // anchor-based).
    const rule = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule" r JOIN "asset_document" d ON d.id = r.asset_document_id WHERE d.asset_id = $1 AND r.frequency = 'M1'`,
      [assetId],
    );
    expect(rule.rowCount).toBe(1);
    expect(rule.rows[0].last_completed_on).not.toBeNull();
    const nextDueOn = rule.rows[0].next_due_on as Date;
    expect(nextDueOn.getTime()).toBeGreaterThan(firstDueOn.getTime());

    // THE assertion this slice exists for: the next tick generates the
    // successor job for the advanced due date.
    const second = await scheduler.run();
    expect(second.ran && second.generated).toBe(1);
    const jobs2 = await adminPool.query(
      `SELECT id, due_on, status FROM "job" WHERE asset_id = $1 ORDER BY due_on`,
      [assetId],
    );
    expect(jobs2.rowCount).toBe(2);
    const successor = jobs2.rows.find((r) => r.id !== firstJobId)!;
    expect(successor.status).toBe('scheduled');
    expect((successor.due_on as Date).toISOString()).toBe(nextDueOn.toISOString());
  });

  it('PR-056 cascade rule: completing the Y job resets the clocks of every subsumed frequency (M1 too), audited as schedule_rule updates', async () => {
    const { assetId, itemIds } = await makeSchedulableAsset(['M1', 'Y']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    const first = await scheduler.run();
    // Two rules (M1, Y) both due at anchor -> two jobs: scope [M1] and [M1,Y].
    expect(first.ran && first.generated).toBe(2);
    const yJob = await adminPool.query(
      `SELECT id FROM "job" WHERE asset_id = $1 AND frequency = 'Y'`,
      [assetId],
    );
    expect(yJob.rowCount).toBe(1);

    await completeJob(yJob.rows[0].id as string, itemIds, users);

    const rules = await adminPool.query(
      `SELECT frequency, last_completed_on, next_due_on FROM "schedule_rule" r JOIN "asset_document" d ON d.id = r.asset_document_id WHERE d.asset_id = $1 ORDER BY r.frequency`,
      [assetId],
    );
    expect(rules.rowCount).toBe(2);
    for (const row of rules.rows) {
      // BOTH rules moved: completing the annual PM also resets the monthly
      // clock (frequency_scope = [M1, Y] — the 1M work was done as part of
      // the annual).
      expect(row.last_completed_on).not.toBeNull();
    }
    const m1 = rules.rows.find((r) => r.frequency === 'M1')!;
    const y = rules.rows.find((r) => r.frequency === 'Y')!;
    // Rolling next-dues: M1 +1 month, Y +12 months from the SAME completion.
    const m1Next = new Date(m1.next_due_on as Date);
    const yNext = new Date(y.next_due_on as Date);
    expect(yNext.getTime()).toBeGreaterThan(m1Next.getTime());

    // INV-09 discipline — the cascade audits each schedule_rule move within
    // the verify transaction.
    // Slice 27-ASSETDOC: `entity_id` is the asset_document, not the asset.
    const audit = await adminPool.query(
      `SELECT a.after FROM "audit_event" a
       JOIN "asset_document" d ON d.id = a.entity_id
       WHERE a.entity_type = 'schedule_rule' AND d.asset_id = $1 AND a.action = 'update'`,
      [assetId],
    );
    // One update event per cascaded rule (M1 + Y). (The bootstrap's own
    // `create` event for the same document is action='create', excluded above.)
    expect(audit.rowCount).toBe(2);
    const frequencies = audit.rows.map((r) => (r.after as { frequency: string }).frequency).sort();
    expect(frequencies).toEqual(['M1', 'Y']);
  });

  it('a NON-final verify does not touch the schedule (the cascade fires only on the archiving stage)', async () => {
    const { assetId, itemIds } = await makeSchedulableAsset(['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);
    await scheduler.run();
    const jobs = await adminPool.query(`SELECT id FROM "job" WHERE asset_id = $1`, [assetId]);
    const jobId = jobs.rows[0].id as string;

    const server = app.getHttpServer();
    await request(server)
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(users.tlToken))
      .send({ assigneeId: users.maintainerId })
      .expect(200);
    for (const templateItemId of itemIds) {
      await request(server)
        .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
        .set(...authHeader(users.maintainerToken))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(200);
    }
    await request(server)
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(users.maintainerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(server)
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(users.tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    const rule = await adminPool.query(
      `SELECT last_completed_on FROM "schedule_rule" r JOIN "asset_document" d ON d.id = r.asset_document_id WHERE d.asset_id = $1 AND r.frequency = 'M1'`,
      [assetId],
    );
    expect(rule.rows[0].last_completed_on).toBeNull();
  });
});
