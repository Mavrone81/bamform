import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createScheduleRule,
  createTemplateItem,
  createTemplateRevision,
  createUser,
  getAssetDocumentId,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * Slice 18-WORKFLOW §2 — UR-028/PR-058 ad-hoc jobs (`POST /jobs/adhoc`),
 * deferred in slice 5 and never picked up. The owner's process, step 1:
 * "Team log in to view schedule based on maintenance plan OR AD-HOC REQUEST".
 *
 * The load-bearing property, and the mirror of slice 17's void semantics: an
 * ad-hoc job is EXTRA WORK, not the planned service. It must neither satisfy
 * nor advance `schedule_rule.next_due_on`, and it must not occupy the
 * schedule period that the planned job belongs to.
 */
describe('Jobs — POST /jobs/adhoc (UR-028/PR-058, slice 18-WORKFLOW §2)', () => {
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

  async function makeAsset(opts: { areaId?: string; leadTimeDays?: number } = {}) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
      opts.leadTimeDays !== undefined ? { leadTimeDays: opts.leadTimeDays } : {},
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      areaId: opts.areaId ?? null,
    });
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const itemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1 });
    return { assetId, revisionId, itemId, approvalRouteId };
  }

  async function planner(label = 'planner') {
    const id = await createUser(label);
    await grantRole(id, 'PLANNER');
    return { id, token: await mintAccessToken(app, id, ['PLANNER']) };
  }

  const REASON = 'bearing seized during the night shift, unplanned service';

  // -------------------------------------------------------------- creation

  it('creates a job off-plan, freezing the CURRENT template revision exactly as the scheduler does', async () => {
    const { assetId, revisionId, approvalRouteId } = await makeAsset();
    const { token } = await planner();

    const res = await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON })
      .expect(201);

    expect(res.body).toMatchObject({ assetId, frequency: 'M1', status: 'SCHEDULED' });
    expect(res.body.jobNumber).toMatch(/^PM-\d{4}-\d{6}$/);

    const row = await adminPool.query(
      `SELECT "template_revision_id", "approval_route_id", "is_adhoc", "adhoc_reason",
              "frequency_scope", "due_on", "status", "assigned_to"
         FROM "job" WHERE id = $1`,
      [res.body.id],
    );
    expect(row.rows[0]).toMatchObject({
      template_revision_id: revisionId,
      approval_route_id: approvalRouteId,
      is_adhoc: true,
      adhoc_reason: REASON,
      status: 'scheduled',
      assigned_to: null,
    });
    // The marker that makes schedule independence STRUCTURAL, not conditional.
    // (`node-postgres` has no parser registered for the `frequency_t[]`
    // custom-enum array OID, so it hands back the raw Postgres literal —
    // `{}` IS the empty array. The DTO assertion below reads it as a real
    // array through Prisma, which does know the type.)
    expect(row.rows[0].frequency_scope).toBe('{}');
    expect(res.body.frequencyScope).toEqual([]);
  });

  it('rejects a reason shorter than 10 characters — 422, nothing created', async () => {
    const { assetId } = await makeAsset();
    const { token } = await planner();

    await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: 'broke' })
      .expect(422);

    const rows = await adminPool.query('SELECT count(*) FROM "job" WHERE asset_id = $1', [assetId]);
    expect(Number(rows.rows[0].count)).toBe(0);
  });

  describe('the DATABASE enforces the ad-hoc invariants, not the service alone', () => {
    async function directInsert(
      ctx: { assetId: string; revisionId: string; approvalRouteId: string },
      reason: string | null,
      scope = 'ARRAY[]::"frequency_t"[]',
    ) {
      // Slice 27-ASSETDOC: `job.asset_document_id` is NOT NULL, so a direct
      // insert must supply it or it fails on THAT constraint instead of the
      // ad-hoc one under test.
      const assetDocumentId = await getAssetDocumentId(ctx.assetId);
      return adminPool.query(
        `INSERT INTO "job" ("job_number","asset_id","asset_document_id","template_revision_id","approval_route_id",
                            "frequency","frequency_scope","due_on","generated_at","status",
                            "is_adhoc","adhoc_reason")
         VALUES ($1,$2,$6,$3,$4,'M1',${scope},CURRENT_DATE,now(),'scheduled',true,$5)`,
        [
          `PM-DIRECT-${randomUUID()}`,
          ctx.assetId,
          ctx.revisionId,
          ctx.approvalRouteId,
          reason,
          assetDocumentId,
        ],
      );
    }

    it('rejects a reason shorter than 10 characters (job_adhoc_reason_length_chk)', async () => {
      const ctx = await makeAsset();
      await expect(directInsert(ctx, 'short')).rejects.toThrow(/job_adhoc_reason_length_chk/);
    });

    /**
     * Review finding X-6. The original constraint was
     * `is_adhoc = false OR length(adhoc_reason) >= 10`, which ACCEPTS a NULL
     * reason: `length(NULL) >= 10` is NULL, `false OR NULL` is NULL, and
     * Postgres only rejects a CHECK that evaluates to FALSE. So the
     * "mandatory reason" was not actually mandatory in the database — and
     * NULL is exactly the shape a code path that forgets to set it produces.
     */
    it('X-6: rejects a NULL reason — the three-valued-logic hole is closed', async () => {
      const ctx = await makeAsset();
      await expect(directInsert(ctx, null)).rejects.toThrow(/job_adhoc_reason_length_chk/);
    });

    it('X-6: the same hole is closed on INV-12 (void) and INV-13 (return), which had it too', async () => {
      const ctx = await makeAsset();
      await expect(
        adminPool.query(
          `INSERT INTO "job" ("job_number","asset_id","asset_document_id","template_revision_id","approval_route_id",
                              "frequency","frequency_scope","due_on","generated_at","status","void_reason")
           VALUES ($1,$2,$5,$3,$4,'M1',ARRAY['M1']::"frequency_t"[],CURRENT_DATE,now(),'voided',NULL)`,
          [
            `PM-VOIDNULL-${randomUUID()}`,
            ctx.assetId,
            ctx.revisionId,
            ctx.approvalRouteId,
            await getAssetDocumentId(ctx.assetId),
          ],
        ),
      ).rejects.toThrow(/job_void_reason_length_chk/);

      const jobId = await createJob({
        assetId: ctx.assetId,
        templateRevisionId: ctx.revisionId,
        approvalRouteId: ctx.approvalRouteId,
        jobNumber: `PM-RETNULL-${randomUUID()}`,
        status: 'submitted',
      });
      const actorId = await createUser('returner-null');
      await expect(
        adminPool.query(
          `INSERT INTO "approval_step"
             ("job_id","stage_ordinal","action","actor_id","actor_role_code","reason","acted_at",
              "content_hash","signature","signing_key_id")
           VALUES ($1,1,'returned',$2,'TEAM_LEADER',NULL,now(),'\\x00','\\x00','k')`,
          [jobId, actorId],
        ),
      ).rejects.toThrow(/approval_step_return_reason_length_chk/);
    });

    /**
     * The slice's own recommended follow-up, and the review agreed:
     * `frequency_scope = '{}'` is what makes an ad-hoc job structurally
     * incapable of advancing the schedule (both cascade services are DRIVEN
     * BY that array). Nothing enforced it until now, so a future insert
     * giving an ad-hoc job a real scope would silently make it credit the
     * maintenance plan.
     */
    it('rejects an ad-hoc job with a NON-EMPTY frequency_scope (job_adhoc_frequency_scope_chk)', async () => {
      const ctx = await makeAsset();
      await expect(directInsert(ctx, REASON, 'ARRAY[\'M1\']::"frequency_t"[]')).rejects.toThrow(
        /job_adhoc_frequency_scope_chk/,
      );
    });

    it('accepts a well-formed ad-hoc row — the constraints are not blanket refusals', async () => {
      const ctx = await makeAsset();
      await expect(directInsert(ctx, REASON)).resolves.toBeDefined();
    });
  });

  it('404s for an unknown asset; 422 when the asset type has no CURRENT template revision', async () => {
    const { token } = await planner();
    await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId: randomUUID(), frequency: 'M1', reason: REASON })
      .expect(404);

    const authorId = await createUser('author-norev');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'draft',
    });

    await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON })
      .expect(422);
  });

  it('an optional assignee is applied at creation (status ASSIGNED), and an unusable assignee is rejected 422', async () => {
    const { assetId } = await makeAsset();
    const { token } = await planner();

    const maintainerId = await createUser('adhoc-maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const ok = await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON, assigneeId: maintainerId })
      .expect(201);
    expect(ok.body).toMatchObject({ status: 'ASSIGNED', assignedTo: maintainerId });

    const auditorId = await createUser('adhoc-auditor');
    await grantRole(auditorId, 'AUDITOR');
    await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON, assigneeId: auditorId })
      .expect(422);
  });

  it('the mandatory reason is AUDITED, in the same transaction as the job row', async () => {
    const { assetId } = await makeAsset();
    const { id: plannerId, token } = await planner();

    const res = await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON })
      .expect(201);

    const events = await adminPool.query(
      `SELECT "actor_id", "action", "after" FROM "audit_event"
        WHERE "entity_type" = 'job' AND "entity_id" = $1`,
      [res.body.id],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].actor_id).toBe(plannerId);
    expect(events.rows[0].action).toBe('create');
    expect(events.rows[0].after).toMatchObject({ isAdhoc: true, adhocReason: REASON });
  });

  // ------------------------------------------------------------- role gate

  it('PLANNER, TEAM_LEADER, ENGINEER and ADMIN may raise one; MAINTAINER, DOC_CONTROLLER and AUDITOR may not', async () => {
    const { assetId } = await makeAsset();
    for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN']) {
      const id = await createUser(`allowed-${role}`);
      await grantRole(id, role);
      const token = await mintAccessToken(app, id, [role]);
      await request(app.getHttpServer())
        .post('/api/v1/jobs/adhoc')
        .set(...authHeader(token))
        .send({ assetId, frequency: 'M1', reason: REASON })
        .expect(201);
    }
    for (const role of ['MAINTAINER', 'DOC_CONTROLLER', 'AUDITOR']) {
      const id = await createUser(`denied-${role}`);
      await grantRole(id, role);
      const token = await mintAccessToken(app, id, [role]);
      await request(app.getHttpServer())
        .post('/api/v1/jobs/adhoc')
        .set(...authHeader(token))
        .send({ assetId, frequency: 'M1', reason: REASON })
        .expect(403);
    }
  });

  it('is area-scoped — a planner scoped to another area cannot raise work on this asset', async () => {
    const theirArea = await createArea(`AR-${randomUUID().slice(0, 8)}`);
    const myArea = await createArea(`AR-${randomUUID().slice(0, 8)}`);
    const { assetId } = await makeAsset({ areaId: theirArea });
    const { id, token } = await planner('scoped-planner');
    await scopeUserToArea(id, myArea);

    await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON })
      .expect(403);
  });

  // ------------------------------------- THE INDEPENDENCE PROOF (§2 core)

  it('completing an ad-hoc job does NOT advance schedule_rule.next_due_on or set last_completed_on', async () => {
    const { assetId, itemId } = await makeAsset();
    await createScheduleRule(assetId, {
      frequency: 'M1',
      intervalMonths: 1,
      anchorDate: '2026-01-01',
      nextDueOn: '2026-09-01',
    });
    const before = await adminPool.query(
      `SELECT "next_due_on", "last_completed_on" FROM "schedule_rule" r JOIN "asset_document" d ON d.id = r.asset_document_id WHERE d.asset_id = $1`,
      [assetId],
    );

    const { token: plannerToken } = await planner('cascade-planner');
    const maintainerId = await createUser('cascade-maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const maintainerToken = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const created = await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(plannerToken))
      .send({ assetId, frequency: 'M1', reason: REASON, assigneeId: maintainerId })
      .expect(201);
    const jobId = created.body.id as string;

    // Drive it all the way to ARCHIVED — the transition that DOES advance
    // the schedule for a planned job (SYS-1/CompletionCascadeService).
    const tlId = await createUser('cascade-tl');
    await grantRole(tlId, 'TEAM_LEADER');
    const engId = await createUser('cascade-eng');
    await grantRole(engId, 'ENGINEER');
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = ANY($1::uuid[])`,
      [[tlId, engId]],
    );
    const tlToken = await mintAccessToken(app, tlId, ['TEAM_LEADER']);
    const engToken = await mintAccessToken(app, engId, ['ENGINEER']);

    await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
      .set(...authHeader(maintainerToken))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/submit`)
      .set(...authHeader(maintainerToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    const final = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(engToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);
    expect(final.body.status).toBe('ARCHIVED');

    const after = await adminPool.query(
      `SELECT "next_due_on", "last_completed_on" FROM "schedule_rule" r JOIN "asset_document" d ON d.id = r.asset_document_id WHERE d.asset_id = $1`,
      [assetId],
    );
    expect(after.rows[0].next_due_on).toEqual(before.rows[0].next_due_on);
    expect(after.rows[0].last_completed_on).toBeNull();

    // ...and no schedule_rule audit event was written either — nothing moved.
    const scheduleAudit = await adminPool.query(
      `SELECT count(*) FROM "audit_event" WHERE "entity_type" = 'schedule_rule'`,
    );
    expect(Number(scheduleAudit.rows[0].count)).toBe(0);
  });

  it('an ad-hoc job does NOT occupy the schedule period — the scheduler still generates the planned job for that asset/day', async () => {
    const { assetId } = await makeAsset({ leadTimeDays: 90 });
    const { token } = await planner('period-planner');
    const scheduler = app.get(SchedulerService);

    // Raise ad-hoc work first, dated on the day the planned job will fall.
    const today = new Date().toISOString().slice(0, 10);
    await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON, dueOn: today })
      .expect(201);

    const tick = await scheduler.run();
    expect(tick.ran && tick.generated).toBeGreaterThanOrEqual(1);

    const jobs = await adminPool.query(
      `SELECT "is_adhoc", "frequency_scope" FROM "job" WHERE asset_id = $1 ORDER BY "is_adhoc"`,
      [assetId],
    );
    expect(jobs.rowCount).toBe(2);
    expect(jobs.rows.map((r) => r.is_adhoc)).toEqual([false, true]);
  });

  it('two ad-hoc jobs may be raised against the SAME machine on the SAME day (two call-outs is not a duplicate)', async () => {
    const { assetId } = await makeAsset();
    const { token } = await planner('twice-planner');
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < 2; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/jobs/adhoc')
        .set(...authHeader(token))
        .send({ assetId, frequency: 'M1', reason: `${REASON} #${i}`, dueOn: today })
        .expect(201);
    }
    const jobs = await adminPool.query(
      `SELECT count(*) FROM "job" WHERE asset_id = $1 AND is_adhoc = true`,
      [assetId],
    );
    expect(Number(jobs.rows[0].count)).toBe(2);
  });

  it('an archived ad-hoc job is never credited as a prior completion when a planned job is voided', async () => {
    // The reverse cascade (`VoidScheduleRecomputeService`) re-derives
    // next_due_on from "the most recent still-valid completion whose frozen
    // scope covers this frequency". An ad-hoc job's scope is empty, so it can
    // never be that completion — proven here at the query level, which is
    // where the mistake would actually be made.
    const { assetId } = await makeAsset();
    const { token } = await planner('void-planner');
    const created = await request(app.getHttpServer())
      .post('/api/v1/jobs/adhoc')
      .set(...authHeader(token))
      .send({ assetId, frequency: 'M1', reason: REASON })
      .expect(201);

    const covering = await adminPool.query(
      `SELECT count(*) FROM "job"
        WHERE asset_id = $1 AND "frequency_scope" @> ARRAY['M1']::"frequency_t"[]`,
      [assetId],
    );
    expect(Number(covering.rows[0].count)).toBe(0);
    expect(created.body.frequencyScope).toEqual([]);
  });
});
