import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetDocument,
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
 * Slice 27-ASSETDOC, spec §4.3 — THE defect this slice can most easily ship.
 *
 * `CompletionCascadeService` and `VoidScheduleRecomputeService` both walk
 * backwards from a completed job to the schedule rules it satisfies. Both
 * resolved those rules by `assetId` + the job's frozen `frequencyScope`, which
 * was correct only while a machine carried ONE document.
 *
 * Once TE7 carries a monthly pH-meter check AND its monthly preventive
 * maintenance, completing the PM would advance the pH check's schedule too. The
 * pH check would silently stop coming due; no error, no overdue flag, nothing
 * to see — the machine would simply stop being checked, and the first anyone
 * would know is an audit finding. Everything in this file is about that.
 */
describe('schedules do not leak across documents on one machine (slice 27, spec §4.3)', () => {
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

  interface SeededDocument {
    id: string;
    templateId: string;
    revisionId: string;
    itemIds: string[];
  }

  /**
   * One machine, two independent documents, each with its own template, its own
   * current revision and its own items. This is TE7: a pH-meter check and a
   * preventive maintenance, both monthly, on one machine.
   */
  async function seedTwoDocuments(
    docAFrequencies: Array<'M1' | 'M3' | 'M6' | 'Y'>,
    docBFrequencies: Array<'M1' | 'M3' | 'M6' | 'Y'>,
  ): Promise<{ assetId: string; docA: SeededDocument; docB: SeededDocument }> {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();

    // The asset type is now only the machine family (approval route + lead
    // time). Lead time 90 days so an advanced next_due_on is inside the
    // generation window on a later tick.
    const assetTypeId = await createAssetType(
      await createFormTemplate(`DOC-UNUSED-${randomUUID()}`),
      approvalRouteId,
      `AT-${randomUUID()}`,
      { leadTimeDays: 90 },
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      // This test builds the machine's documents itself.
      skipDefaultDocument: true,
    });

    async function tagDocument(
      label: string,
      frequencies: Array<'M1' | 'M3' | 'M6' | 'Y'>,
    ): Promise<SeededDocument> {
      const templateId = await createFormTemplate(`DOC-${label}-${randomUUID()}`);
      const revisionId = await createTemplateRevision(templateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
      });
      const itemIds: string[] = [];
      for (const frequency of frequencies) {
        itemIds.push(await createTemplateItem(revisionId, frequency));
      }
      const id = await createAssetDocument(assetId, templateId);
      return { id, templateId, revisionId, itemIds };
    }

    return {
      assetId,
      docA: await tagDocument('A', docAFrequencies),
      docB: await tagDocument('B', docBFrequencies),
    };
  }

  async function makeUsers() {
    const tlId = await createUser('tl');
    await grantRole(tlId, 'TEAM_LEADER');
    const engId = await createUser('eng');
    await grantRole(engId, 'ENGINEER');
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const adminId = await createUser('admin');
    await grantRole(adminId, 'ADMIN');
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = ANY($1::uuid[])`,
      [[tlId, engId, adminId]],
    );
    return {
      maintainerId,
      adminId,
      tlToken: await mintAccessToken(app, tlId, ['TEAM_LEADER']),
      engToken: await mintAccessToken(app, engId, ['ENGINEER']),
      maintainerToken: await mintAccessToken(app, maintainerId, ['MAINTAINER']),
      adminToken: await mintAccessToken(app, adminId, ['ADMIN']),
    };
  }

  /** assign → record every item → submit → verify → verify(archives). Real HTTP. */
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

  async function ruleFor(assetDocumentId: string, frequency: string) {
    const result = await adminPool.query(
      `SELECT last_completed_on, next_due_on FROM "schedule_rule"
        WHERE asset_document_id = $1 AND frequency = $2::"frequency_t"`,
      [assetDocumentId, frequency],
    );
    expect(result.rowCount).toBe(1);
    return result.rows[0] as { last_completed_on: Date | null; next_due_on: Date };
  }

  async function jobIdFor(assetDocumentId: string, frequency: string): Promise<string> {
    const result = await adminPool.query(
      `SELECT id FROM "job"
        WHERE asset_document_id = $1 AND frequency = $2::"frequency_t" AND status <> 'voided'`,
      [assetDocumentId, frequency],
    );
    expect(result.rowCount).toBe(1);
    return result.rows[0].id as string;
  }

  it("completing document A leaves document B's schedule untouched", async () => {
    const { docA, docB } = await seedTwoDocuments(['M1'], ['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);

    // Both documents bootstrap an M1 rule and raise a job. That both jobs
    // exist at all is what the re-keyed period index buys (spec §4.2).
    const tick = await scheduler.run();
    expect(tick.ran && tick.generated).toBe(2);

    const beforeB = await ruleFor(docB.id, 'M1');
    await completeJob(await jobIdFor(docA.id, 'M1'), docA.itemIds, users);

    const afterB = await ruleFor(docB.id, 'M1');
    // THE assertion. Before the fix, B moved with A.
    expect(afterB.next_due_on).toEqual(beforeB.next_due_on);
    expect(afterB.last_completed_on).toEqual(beforeB.last_completed_on);
    expect(afterB.last_completed_on).toBeNull();

    // ...and A really did move, so the test cannot pass by the cascade simply
    // doing nothing at all.
    const afterA = await ruleFor(docA.id, 'M1');
    expect(afterA.last_completed_on).not.toBeNull();
    expect(afterA.next_due_on.getTime()).toBeGreaterThan(beforeB.next_due_on.getTime());
  });

  it("voiding document A's archived job leaves document B's schedule untouched", async () => {
    const { docA, docB } = await seedTwoDocuments(['M1'], ['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);
    await scheduler.run();

    const jobId = await jobIdFor(docA.id, 'M1');
    await completeJob(jobId, docA.itemIds, users);

    const beforeB = await ruleFor(docB.id, 'M1');
    const advancedA = await ruleFor(docA.id, 'M1');

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(users.adminToken))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Raised against the wrong machine — slice 27 cross-document check' })
      .expect(200);

    const afterB = await ruleFor(docB.id, 'M1');
    expect(afterB.next_due_on).toEqual(beforeB.next_due_on);
    expect(afterB.last_completed_on).toEqual(beforeB.last_completed_on);

    // A's own schedule really was reversed — no valid completion remains, so
    // last_completed_on clears and next_due_on reverts to the voided job's own
    // due date (slice 17's rule, unchanged by the re-key).
    const afterA = await ruleFor(docA.id, 'M1');
    expect(afterA.last_completed_on).toBeNull();
    expect(afterA.next_due_on).not.toEqual(advancedA.next_due_on);
  });

  it('the 3M cascade still reaches 1M WITHIN a document, and only within it', async () => {
    // The frequency cascade (3M satisfies 1M) is scoped by `frequencyScope`,
    // which is orthogonal to the document. It must survive the re-key intact —
    // and must not become a route by which one document's completion reaches
    // another's rules.
    const { docA, docB } = await seedTwoDocuments(['M1', 'M3'], ['M1']);
    const users = await makeUsers();
    const scheduler = app.get(SchedulerService);
    await scheduler.run();

    const m3JobId = await jobIdFor(docA.id, 'M3');
    await completeJob(m3JobId, docA.itemIds, users);

    // Within document A, the M3 completion satisfies M1 too.
    expect((await ruleFor(docA.id, 'M1')).last_completed_on).not.toBeNull();
    expect((await ruleFor(docA.id, 'M3')).last_completed_on).not.toBeNull();
    // Document B's M1 is untouched.
    expect((await ruleFor(docB.id, 'M1')).last_completed_on).toBeNull();
  });

  it('two documents at the same frequency on one machine BOTH generate jobs, against different revisions', async () => {
    // Spec §6 — the case the old `@@unique([assetId, frequency])` and the old
    // by-asset job period key each made impossible, and the one TE7 needs.
    const { assetId, docA, docB } = await seedTwoDocuments(['M1'], ['M1']);
    const scheduler = app.get(SchedulerService);

    const tick = await scheduler.run();
    expect(tick.ran && tick.generated).toBe(2);

    const jobs = await adminPool.query(
      `SELECT asset_document_id, template_revision_id FROM "job" WHERE asset_id = $1`,
      [assetId],
    );
    expect(jobs.rowCount).toBe(2);
    expect(new Set(jobs.rows.map((r) => r.asset_document_id)).size).toBe(2);
    // The template is resolved from the DOCUMENT, not the asset type — so the
    // two jobs carry different frozen revisions.
    expect(new Set(jobs.rows.map((r) => r.template_revision_id)).size).toBe(2);
    expect(new Set(jobs.rows.map((r) => r.template_revision_id))).toEqual(
      new Set([docA.revisionId, docB.revisionId]),
    );
  });

  it('a DEACTIVATED document stops generating jobs and leaves its sibling generating', async () => {
    const { docA, docB } = await seedTwoDocuments(['M1'], ['M1']);
    const scheduler = app.get(SchedulerService);

    await adminPool.query(`UPDATE "asset_document" SET active = false WHERE id = $1`, [docB.id]);

    const tick = await scheduler.run();
    expect(tick.ran && tick.generated).toBe(1);

    const jobs = await adminPool.query(
      `SELECT asset_document_id FROM "job" WHERE asset_document_id = ANY($1::uuid[])`,
      [[docA.id, docB.id]],
    );
    expect(jobs.rows.map((r) => r.asset_document_id)).toEqual([docA.id]);
  });
});
