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
 * PR-API-24/25/26, PR-062, PR-082 — `POST /sync/outbox`: dispatches to the
 * SAME slice-6 `ResultsService`/`PartsService` methods, per-mutation
 * results (not all-or-nothing), `id`-as-idempotency-key (I-INV-16/17),
 * submit rejected inside a batch.
 */
describe('Sync — POST /sync/outbox', () => {
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

  async function makeAssignedJob() {
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
      status: 'assigned',
      assignedTo: maintainerId,
    });

    return { jobId, itemId, measurementId, maintainerId, token };
  }

  function drain(app: INestApplication, token: string, mutations: unknown[]) {
    return request(app.getHttpServer())
      .post('/api/v1/sync/outbox')
      .set(...authHeader(token))
      .send({ mutations });
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/sync/outbox')
      .send({ mutations: [] })
      .expect(401);
  });

  it('rejects a caller without a JOB_RECORD role (e.g. AUDITOR)', async () => {
    const { jobId, itemId } = await makeAssignedJob();
    const auditorId = await createUser('auditor');
    await grantRole(auditorId, 'AUDITOR');
    const token = await mintAccessToken(app, auditorId, ['AUDITOR']);

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE' },
      },
    ]);
    expect(res.status).toBe(403);
  });

  it('applies a valid item-result mutation and returns applied:true', async () => {
    const { jobId, itemId, token } = await makeAssignedJob();
    const mutationId = randomUUID();

    const res = await drain(app, token, [
      {
        id: mutationId,
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE', remark: 'Filter replaced' },
      },
    ]).expect(200);

    expect(res.body.results).toEqual([{ id: mutationId, status: 200, applied: true }]);
    expect(res.body.syncToken).toEqual(expect.any(String));

    const row = await adminPool.query('SELECT status FROM "item_result" WHERE job_id = $1', [
      jobId,
    ]);
    expect(row.rows[0].status).toBe('done');
  });

  it('I-INV-16: replaying the SAME batch (same mutation ids/bodies) returns the ORIGINAL per-mutation results, no double-apply', async () => {
    const { jobId, itemId, token } = await makeAssignedJob();
    const mutations = [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE', remark: 'once' },
      },
    ];

    const first = await drain(app, token, mutations).expect(200);
    const second = await drain(app, token, mutations).expect(200);

    expect(second.body.results).toEqual(first.body.results);

    const rows = await adminPool.query('SELECT count(*) FROM "item_result" WHERE job_id = $1', [
      jobId,
    ]);
    expect(Number(rows.rows[0].count)).toBe(1);
    const jobRow = await adminPool.query('SELECT draft_version FROM "job" WHERE id = $1', [jobId]);
    expect(jobRow.rows[0].draft_version).toBe(1); // NOT incremented a second time
  });

  it('I-INV-17: the SAME mutation id with a DIFFERENT body is rejected 422 idempotency-mismatch, without blocking the batch', async () => {
    const { jobId, itemId, token } = await makeAssignedJob();
    const mutationId = randomUUID();

    await drain(app, token, [
      {
        id: mutationId,
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE' },
      },
    ]).expect(200);

    const res = await drain(app, token, [
      {
        id: mutationId,
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'NOT_DONE' },
      },
    ]).expect(200); // the ENDPOINT is 200 — the mismatch is a per-mutation result

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      id: mutationId,
      applied: false,
      status: 422,
      problem: { type: '/errors/idempotency-mismatch' },
    });
  });

  it('PR-API-24/PR-082: applies mutations in `sequence` order, not client array order', async () => {
    const { jobId, itemId, token } = await makeAssignedJob();

    // Array order is [NOT_DONE, DONE] but sequence order is [DONE, NOT_DONE]
    // — the final recorded status must be NOT_DONE (sequence 2, applied last).
    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 2,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'NOT_DONE' },
      },
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE' },
      },
    ]).expect(200);

    expect(res.body.results.every((r: { applied: boolean }) => r.applied)).toBe(true);

    const row = await adminPool.query('SELECT status FROM "item_result" WHERE job_id = $1', [
      jobId,
    ]);
    expect(row.rows[0].status).toBe('not_done');
  });

  it('one failing mutation does not block the rest of the batch (PR-API-24) — and does not roll back an already-applied mutation for the SAME job (per-mutation transaction, PR-082)', async () => {
    const { jobId, itemId, measurementId, token } = await makeAssignedJob();

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE' },
      },
      {
        // Unknown templateItemId on this job's frozen revision -> 404, must not roll back the mutation above.
        id: randomUUID(),
        sequence: 2,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${randomUUID()}`,
        body: { status: 'DONE' },
      },
      {
        id: randomUUID(),
        sequence: 3,
        method: 'PUT',
        path: `/jobs/${jobId}/measurements/${measurementId}`,
        body: { readingNumeric: 12 },
      },
    ]).expect(200);

    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0]).toMatchObject({ applied: true, status: 200 });
    expect(res.body.results[1]).toMatchObject({ applied: false, status: 404 });
    expect(res.body.results[2]).toMatchObject({ applied: true, status: 200 });

    // The first (valid) mutation's write survived the second one's failure —
    // proving each mutation commits its OWN transaction, not a single
    // transaction shared across the whole job's mutations in this batch.
    const itemRow = await adminPool.query('SELECT status FROM "item_result" WHERE job_id = $1', [
      jobId,
    ]);
    expect(itemRow.rows[0].status).toBe('done');
    const measurementRow = await adminPool.query(
      'SELECT reading_numeric FROM "measurement_result" WHERE job_id = $1',
      [jobId],
    );
    expect(Number(measurementRow.rows[0].reading_numeric)).toBe(12);
  });

  it('PR-API-26/PR-065: rejects a submit mutation inside the batch — submit is never routed through the outbox', async () => {
    const { jobId, itemId, token } = await makeAssignedJob();

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/items/${itemId}`,
        body: { status: 'DONE' },
      },
      {
        id: randomUUID(),
        sequence: 2,
        method: 'POST',
        path: `/jobs/${jobId}/submit`,
        body: null,
      },
    ]).expect(200);

    expect(res.body.results[0]).toMatchObject({ applied: true });
    expect(res.body.results[1]).toMatchObject({ applied: false, status: 422 });
    expect(res.body.results[1].problem.detail).toMatch(/not permitted/i);

    const jobRow = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(jobRow.rows[0].status).not.toBe('submitted');
  });

  it('PR-API-27: rejects an attachments mutation inside the batch — attachments are a separate channel', async () => {
    const { jobId, token } = await makeAssignedJob();

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'POST',
        path: `/jobs/${jobId}/attachments`,
        body: null,
      },
    ]).expect(200);

    expect(res.body.results[0]).toMatchObject({ applied: false, status: 422 });
  });

  it('a POST /jobs/{id}/parts mutation applies via the same reused PartsService', async () => {
    const { jobId, token } = await makeAssignedJob();

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'POST',
        path: `/jobs/${jobId}/parts`,
        body: { description: 'Filter', quantity: 1 },
      },
    ]).expect(200);

    expect(res.body.results[0]).toMatchObject({ applied: true, status: 201 });
    const row = await adminPool.query('SELECT description FROM "part_used" WHERE job_id = $1', [
      jobId,
    ]);
    expect(row.rows[0].description).toBe('Filter');
  });

  it('a PUT /jobs/{id}/parts/{partId} mutation applies as a client-keyed upsert via PartsService#upsertPart', async () => {
    const { jobId, token } = await makeAssignedJob();
    const partId = randomUUID();

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/parts/${partId}`,
        body: { description: 'Oil filter', quantity: 2 },
      },
    ]).expect(200);

    expect(res.body.results[0]).toMatchObject({ id: expect.any(String), applied: true, status: 200 });
    const row = await adminPool.query(
      'SELECT description, quantity, active FROM "part_used" WHERE id = $1',
      [partId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].description).toBe('Oil filter');
    expect(Number(row.rows[0].quantity)).toBe(2);
    expect(row.rows[0].active).toBe(true);
  });

  it('I-INV-16 for part-upsert: replaying the SAME mutation id/body is idempotent (no duplicate row, no duplicate audit event)', async () => {
    const { jobId, token } = await makeAssignedJob();
    const partId = randomUUID();
    const mutations = [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/parts/${partId}`,
        body: { description: 'Belt', quantity: 1 },
      },
    ];

    const first = await drain(app, token, mutations).expect(200);
    const second = await drain(app, token, mutations).expect(200);

    expect(second.body.results).toEqual(first.body.results);

    const rows = await adminPool.query('SELECT count(*) FROM "part_used" WHERE id = $1', [partId]);
    expect(Number(rows.rows[0].count)).toBe(1);

    const auditRows = await adminPool.query(
      "SELECT count(*) FROM \"audit_event\" WHERE entity_type = 'part_used' AND entity_id = $1",
      [partId],
    );
    expect(Number(auditRows.rows[0].count)).toBe(1);
  });

  it('a PUT /jobs/{id}/parts/{partId} mutation with active:false soft-removes the part (non-negotiable #7: no physical DELETE)', async () => {
    const { jobId, token } = await makeAssignedJob();
    const partId = randomUUID();

    await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/parts/${partId}`,
        body: { description: 'Gasket', quantity: 1 },
      },
    ]).expect(200);

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 2,
        method: 'PUT',
        path: `/jobs/${jobId}/parts/${partId}`,
        body: { description: 'Gasket', quantity: 1, active: false },
      },
    ]).expect(200);

    expect(res.body.results[0]).toMatchObject({ applied: true, status: 200 });
    const row = await adminPool.query('SELECT active FROM "part_used" WHERE id = $1', [partId]);
    expect(row.rows).toHaveLength(1); // row still present — soft-removed, not deleted
    expect(row.rows[0].active).toBe(false);
  });

  it('rejects a part-upsert mutation with a non-UUID partId as a per-mutation 404, not a 500 (poison-queue guard)', async () => {
    const { jobId, token } = await makeAssignedJob();

    const res = await drain(app, token, [
      {
        id: randomUUID(),
        sequence: 1,
        method: 'PUT',
        path: `/jobs/${jobId}/parts/not-a-uuid`,
        body: { description: 'Belt', quantity: 1 },
      },
    ]).expect(200);

    expect(res.body.results[0]).toMatchObject({ applied: false, status: 404 });
  });
});
