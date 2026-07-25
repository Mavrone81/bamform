import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateItem,
  createTemplateMeasurement,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * PR-031/032/098 — result capture: idempotency (PR-API-16, I-INV-16/17),
 * ASSIGNED->IN_PROGRESS transition, server-computed judgement (PR-032),
 * same-transaction audit_event (non-negotiable #3), job-status guard.
 */
describe('Jobs — PUT items/measurements (result capture)', () => {
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

  async function makeAssignedJob(
    status: 'assigned' | 'in_progress' | 'submitted' | 'archived' = 'assigned',
  ) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });
    const itemId = await createTemplateItem(revisionId, 'M1', { itemNo: 1 });
    const measurementId = await createTemplateMeasurement(revisionId, {
      lowerLimit: 5,
      upperLimit: 24,
    });

    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);

    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-TEST-${randomUUID()}`,
      status,
      assignedTo: maintainerId,
    });

    return { jobId, itemId, measurementId, maintainerId, token };
  }

  describe('PUT /jobs/{id}/items/{templateItemId}', () => {
    it('requires Idempotency-Key (PR-API-16 — reachable from the offline outbox)', async () => {
      const { jobId, itemId, token } = await makeAssignedJob();
      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .send({ status: 'DONE' })
        .expect(422);
      expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
    });

    it('records the result, transitions ASSIGNED -> IN_PROGRESS, and writes audit_event in the SAME transaction', async () => {
      const { jobId, itemId, token } = await makeAssignedJob();
      const key = randomUUID();

      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', key)
        .send({ status: 'DONE', remark: 'Filter replaced' })
        .expect(200);

      expect(res.body).toMatchObject({
        templateItemId: itemId,
        status: 'DONE',
        remark: 'Filter replaced',
      });

      const jobRow = await adminPool.query(
        'SELECT status, started_at, draft_version FROM "job" WHERE id = $1',
        [jobId],
      );
      expect(jobRow.rows[0].status).toBe('in_progress');
      expect(jobRow.rows[0].started_at).not.toBeNull();
      expect(jobRow.rows[0].draft_version).toBe(1);

      const audit = await adminPool.query(
        `SELECT action FROM "audit_event" WHERE entity_type = 'item_result' AND entity_id = $1`,
        [res.body.id],
      );
      expect(audit.rows[0]?.action).toBe('create');
    });

    it('I-INV-16: replaying the SAME Idempotency-Key with the SAME body returns the original response, no double-apply', async () => {
      const { jobId, itemId, token } = await makeAssignedJob();
      const key = randomUUID();
      const body = { status: 'DONE', remark: 'once' };

      const first = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);

      const second = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);

      expect(second.body).toEqual(first.body);

      const rows = await adminPool.query('SELECT count(*) FROM "item_result" WHERE job_id = $1', [
        jobId,
      ]);
      expect(Number(rows.rows[0].count)).toBe(1);
      // Replayed — draftVersion must NOT have incremented a second time.
      const jobRow = await adminPool.query('SELECT draft_version FROM "job" WHERE id = $1', [
        jobId,
      ]);
      expect(jobRow.rows[0].draft_version).toBe(1);
    });

    it("DBD §6.23 'key scope is per user': the SAME key + SAME body from a DIFFERENT user is rejected, not replayed", async () => {
      const { jobId, itemId, token } = await makeAssignedJob();
      const key = randomUUID();
      const body = { status: 'DONE', remark: 'once' };

      await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);

      // A second, independently-authorised user (TEAM_LEADER has broad
      // visibility over this job, so this isolates the idempotency-scope
      // check itself, not a job-access failure) replays the SAME key and
      // SAME body — must NOT receive the first user's cached response.
      const teamLeaderId = await createUser('team-leader');
      await grantRole(teamLeaderId, 'TEAM_LEADER');
      const tlToken = await mintAccessToken(app, teamLeaderId, ['TEAM_LEADER']);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(tlToken))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(422);
      expect(res.body).toMatchObject({ type: '/errors/idempotency-mismatch' });
    });

    it('I-INV-17: the SAME key with a DIFFERENT body is rejected 422 idempotency-mismatch', async () => {
      const { jobId, itemId, token } = await makeAssignedJob();
      const key = randomUUID();

      await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', key)
        .send({ status: 'DONE' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', key)
        .send({ status: 'NOT_DONE' })
        .expect(422);
      expect(res.body).toMatchObject({ type: '/errors/idempotency-mismatch' });
    });

    it('a second PUT for the SAME item updates it in place (upsert, not a new row)', async () => {
      const { jobId, itemId, token } = await makeAssignedJob();

      await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(200);

      await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'NOT_DONE', remark: 'changed my mind' })
        .expect(200);

      const rows = await adminPool.query(
        'SELECT status, remark FROM "item_result" WHERE job_id = $1',
        [jobId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].status).toBe('not_done');
    });

    it('If-Match mismatch is rejected 409 draft-conflict (PR-API-18)', async () => {
      const { jobId, itemId, token } = await makeAssignedJob();
      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '99')
        .send({ status: 'DONE' })
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/draft-conflict' });
    });

    it('rejects a mutation against a SUBMITTED job (409 invalid-transition)', async () => {
      const { jobId, itemId, token } = await makeAssignedJob('submitted');
      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
    });

    it('rejects a mutation against an ARCHIVED job with the specific record-immutable problem (INV-09)', async () => {
      const { jobId, itemId, token } = await makeAssignedJob('archived');
      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/record-immutable' });
    });

    it('a MAINTAINER not assigned to the job is forbidden from recording a result', async () => {
      const { jobId, itemId } = await makeAssignedJob();
      const otherId = await createUser('other');
      await grantRole(otherId, 'MAINTAINER');
      const token = await mintAccessToken(app, otherId, ['MAINTAINER']);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ status: 'DONE' })
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/forbidden' });
    });
  });

  describe('PUT /jobs/{id}/measurements/{templateMeasurementId} — server-computed judgement (PR-032)', () => {
    it('computes PASS when the reading is within the frozen spec range', async () => {
      const { jobId, measurementId, token } = await makeAssignedJob();
      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/measurements/${measurementId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ readingNumeric: 10 })
        .expect(200);
      expect(res.body).toMatchObject({ readingNumeric: 10, judgement: 'PASS' });
    });

    it('computes FAIL when the reading is out of spec — the client never supplies judgement', async () => {
      const { jobId, measurementId, token } = await makeAssignedJob();
      const res = await request(app.getHttpServer())
        .put(`/api/v1/jobs/${jobId}/measurements/${measurementId}`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .send({ readingNumeric: 999 })
        .expect(200);
      expect(res.body).toMatchObject({ judgement: 'FAIL' });
    });
  });
});
