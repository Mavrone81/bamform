import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Queue } from 'bullmq';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createJobFixture,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { NOTIFICATION_QUEUE } from '../../src/notifications/notification.tokens';

/**
 * SYS-2 (system-review-2026-07-27) — `POST /jobs/{id}/assign` (UR-029/PR-030,
 * API_SPECIFICATION.md §10.5). Before this slice NOTHING in `api/src` wrote
 * `job.assigned_to`, so scheduler-generated jobs (born SCHEDULED, unassigned)
 * were invisible to MAINTAINERs and their only exit was VOID. These tests
 * cover: state semantics (SCHEDULED -> ASSIGNED; reassign keeps
 * ASSIGNED/IN_PROGRESS), role gate (TL/ENG/ADMIN), area scope, assignee
 * validation, audit-in-txn (INV-09 discipline), idempotency, and the UR-061
 * assignment notification (built in slice 11a, wired here).
 */
describe('Jobs — POST /jobs/{id}/assign (UR-029/UR-061, SYS-2)', () => {
  let app: INestApplication;
  let notificationQueue: Queue;

  beforeAll(async () => {
    app = await createTestApp();
    notificationQueue = app.get<Queue>(NOTIFICATION_QUEUE);
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

  async function actor(roleCode: 'TEAM_LEADER' | 'ENGINEER' | 'ADMIN' | 'MAINTAINER') {
    const userId = await createUser(`actor-${roleCode}`);
    await grantRole(userId, roleCode);
    const token = await mintAccessToken(app, userId, [roleCode]);
    return { userId, token };
  }

  async function makeAssignee(label = 'assignee'): Promise<string> {
    const userId = await createUser(label);
    await grantRole(userId, 'MAINTAINER');
    return userId;
  }

  it('UR-029: TEAM_LEADER assigns a SCHEDULED job — 200, status ASSIGNED, assigned_to set, audited in the same transaction', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-${randomUUID()}`, 'scheduled');
    const tl = await actor('TEAM_LEADER');
    const assigneeId = await makeAssignee();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId })
      .expect(200);
    expect(res.body).toMatchObject({ id: jobId, status: 'ASSIGNED', assignedTo: assigneeId });

    const row = await adminPool.query('SELECT status, assigned_to FROM "job" WHERE id = $1', [
      jobId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'assigned', assigned_to: assigneeId });

    const audit = await adminPool.query(
      `SELECT actor_id, action, before, after FROM "audit_event"
       WHERE entity_type = 'job' AND entity_id = $1 AND action = 'state_change'`,
      [jobId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(tl.userId);
    expect(audit.rows[0].before).toMatchObject({ status: 'SCHEDULED', assignedTo: null });
    expect(audit.rows[0].after).toMatchObject({ status: 'ASSIGNED', assignedTo: assigneeId });
  });

  it('UR-061: assigning enqueues a JOB_ASSIGNED notification to the assignee (wired, previously built-but-unwired)', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-NOTIF-${randomUUID()}`, 'scheduled');
    const tl = await actor('TEAM_LEADER');
    const assigneeId = await makeAssignee();

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId })
      .expect(200);

    const queued = await notificationQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    const notif = queued.filter((j) => j.name === 'notification');
    expect(notif).toHaveLength(1);
    expect(notif[0].data).toMatchObject({
      recipientId: assigneeId,
      templateCode: 'JOB_ASSIGNED',
      entityType: 'job',
      entityId: jobId,
    });
  });

  it('UR-029 reassignment: an ASSIGNED job can be reassigned — status stays ASSIGNED, assignee replaced, notification to the NEW assignee', async () => {
    const firstAssignee = await makeAssignee('first');
    const { jobId } = await createJobFixture(`PM-REASSIGN-${randomUUID()}`, 'assigned', {
      assignedTo: firstAssignee,
    });
    const eng = await actor('ENGINEER');
    const secondAssignee = await makeAssignee('second');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(eng.token))
      .send({ assigneeId: secondAssignee })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ASSIGNED', assignedTo: secondAssignee });

    const queued = await notificationQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    const notif = queued.filter((j) => j.name === 'notification');
    expect(notif).toHaveLength(1);
    expect(notif[0].data).toMatchObject({ recipientId: secondAssignee });

    // Reassignment is an update, not a state change — audited as such.
    const audit = await adminPool.query(
      `SELECT action, before, after FROM "audit_event" WHERE entity_type = 'job' AND entity_id = $1`,
      [jobId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe('update');
    expect(audit.rows[0].before).toMatchObject({ assignedTo: firstAssignee });
    expect(audit.rows[0].after).toMatchObject({ assignedTo: secondAssignee });
  });

  it('UR-029 reassignment: an IN_PROGRESS job (assignee deactivated mid-work, SYS-2 stranded-job scenario) can be reassigned without losing recorded results', async () => {
    const firstAssignee = await makeAssignee('deactivated-mid-work');
    const { jobId } = await createJobFixture(`PM-REASSIGN-IP-${randomUUID()}`, 'in_progress', {
      assignedTo: firstAssignee,
    });
    await adminPool.query(`UPDATE "app_user" SET status = 'deactivated' WHERE id = $1`, [
      firstAssignee,
    ]);
    const admin = await actor('ADMIN');
    const secondAssignee = await makeAssignee('replacement');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(admin.token))
      .send({ assigneeId: secondAssignee })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'IN_PROGRESS', assignedTo: secondAssignee });
  });

  it.each(['submitted', 'archived', 'voided'] as const)(
    'rejects assignment of a %s job — 409 invalid-transition (PRD §5.1)',
    async (status) => {
      const { jobId } = await createJobFixture(`PM-ASSIGN-${status}-${randomUUID()}`, status, {
        ...(status === 'submitted' ? { submittedAt: new Date(), currentStageOrdinal: 1 } : {}),
        ...(status === 'archived' ? { archivedAt: new Date() } : {}),
        ...(status === 'voided' ? { voidReason: 'voided for the assignment test' } : {}),
      });
      const tl = await actor('TEAM_LEADER');
      const assigneeId = await makeAssignee();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/assign`)
        .set(...authHeader(tl.token))
        .send({ assigneeId })
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
    },
  );

  it('a MAINTAINER may not assign — 403 (permission matrix §4.1: assignment is TL/ENG/ADMIN)', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-ROLE-${randomUUID()}`, 'scheduled');
    const maintainer = await actor('MAINTAINER');

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(maintainer.token))
      .send({ assigneeId: await makeAssignee() })
      .expect(403);
  });

  it('PR-API-10: an area-scoped TEAM_LEADER cannot assign a job outside their scope — 403 out-of-scope', async () => {
    const areaA = await createArea(`AA-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`AB-${randomUUID().slice(0, 8)}`);
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, { areaId: areaB });
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-SCOPE-${randomUUID()}`,
      status: 'scheduled',
    });

    const tlId = await createUser('tl-scoped');
    await grantRole(tlId, 'TEAM_LEADER');
    await scopeUserToArea(tlId, areaA);
    const token = await mintAccessToken(app, tlId, ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(token))
      .send({ assigneeId: await makeAssignee() })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/out-of-scope' });
  });

  it('rejects an assignee that does not exist — 422 validation-failed', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-NOUSER-${randomUUID()}`, 'scheduled');
    const tl = await actor('TEAM_LEADER');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId: randomUUID() })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
  });

  it('rejects a deactivated assignee — 422 (13a: a deactivated account cannot work the job)', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-DEACT-${randomUUID()}`, 'scheduled');
    const tl = await actor('TEAM_LEADER');
    const assigneeId = await makeAssignee('deactivated');
    await adminPool.query(`UPDATE "app_user" SET status = 'deactivated' WHERE id = $1`, [
      assigneeId,
    ]);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
  });

  it('rejects an assignee holding no result-recording role (§4.1: MAINTAINER/TL/ENG record results) — 422', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-AUDITOR-${randomUUID()}`, 'scheduled');
    const tl = await actor('TEAM_LEADER');
    const auditorId = await createUser('auditor-assignee');
    await grantRole(auditorId, 'AUDITOR');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId: auditorId })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
  });

  it('rejects an assignee whose area scope excludes the job (they could never open it) — 422', async () => {
    const areaA = await createArea(`AC-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`AD-${randomUUID().slice(0, 8)}`);
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, { areaId: areaB });
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-SCOPE2-${randomUUID()}`,
      status: 'scheduled',
    });

    const tl = await actor('TEAM_LEADER');
    const assigneeId = await makeAssignee('scoped-out');
    await scopeUserToArea(assigneeId, areaA);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
  });

  it('assign is idempotent when the client replays the same Idempotency-Key (single audit event, single notification)', async () => {
    const { jobId } = await createJobFixture(`PM-ASSIGN-IDEM-${randomUUID()}`, 'scheduled');
    const tl = await actor('TEAM_LEADER');
    const assigneeId = await makeAssignee();
    const key = randomUUID();

    const first = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .set('Idempotency-Key', key)
      .send({ assigneeId })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .set('Idempotency-Key', key)
      .send({ assigneeId })
      .expect(200);
    expect(second.body).toEqual(first.body);

    const audit = await adminPool.query(
      `SELECT id FROM "audit_event" WHERE entity_type = 'job' AND entity_id = $1`,
      [jobId],
    );
    expect(audit.rowCount).toBe(1);
    const queued = await notificationQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(queued.filter((j) => j.name === 'notification')).toHaveLength(1);
  });

  it('closes the loop: once assigned, the MAINTAINER sees the job in GET /jobs and can start recording (the SYS-2 core failure)', async () => {
    const { jobId, revisionId } = await createJobFixture(
      `PM-ASSIGN-LOOP-${randomUUID()}`,
      'scheduled',
    );
    const itemRow = await adminPool.query(
      `INSERT INTO "template_item" ("template_revision_id", "item_no", "frequency", "instruction", "stable_key", "display_order", "active")
       VALUES ($1, 1, 'M1', 'Check it', $2, 1, true) RETURNING id`,
      [revisionId, randomUUID()],
    );
    const templateItemId = itemRow.rows[0].id as string;
    const tl = await actor('TEAM_LEADER');
    const assigneeId = await makeAssignee('loop-maintainer');
    const assigneeToken = await mintAccessToken(app, assigneeId, ['MAINTAINER']);

    // Before assignment: invisible to the maintainer.
    const before = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .set(...authHeader(assigneeToken))
      .expect(200);
    expect(before.body.data.map((j: { id: string }) => j.id)).not.toContain(jobId);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/assign`)
      .set(...authHeader(tl.token))
      .send({ assigneeId })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .set(...authHeader(assigneeToken))
      .expect(200);
    expect(after.body.data.map((j: { id: string }) => j.id)).toContain(jobId);

    // And the assignee can actually record a result (ASSIGNED -> IN_PROGRESS).
    const rec = await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${templateItemId}`)
      .set(...authHeader(assigneeToken))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DONE' })
      .expect(200);
    expect(rec.body).toMatchObject({ status: 'DONE' });
    const row = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(row.rows[0].status).toBe('in_progress');
  });
});
