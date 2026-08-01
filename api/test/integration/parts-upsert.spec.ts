import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createJobFixture,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

// Single module-level teardown: the pool (and app/redis, once created) must close exactly
// once for the whole file — a second `describe`-scoped afterAll would end the shared pg pool
// twice and break later suites (see schema-constraints.spec.ts for the same pattern).
let app: INestApplication | undefined;

afterAll(async () => {
  if (app) await app.close();
  await closeRedis();
  await closeAll();
});

describe('part_used.active', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('defaults active=true on insert', async () => {
    const { jobId, authorId } = await createJobFixture('PM-PARTS-1', 'in_progress');
    const { rows } = await adminPool.query(
      `INSERT INTO "part_used" ("job_id","description","quantity","recorded_by")
       VALUES ($1,'Filter','1',$2) RETURNING "active"`,
      [jobId, authorId],
    );
    expect(rows[0].active).toBe(true);
  });
});

/** Slice 30 — client-keyed PUT upsert (create/update/soft-remove), edit-window, idempotent replay. */
describe('Jobs — PUT /jobs/{id}/parts/{partId}', () => {
  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  async function makeInProgressJobAssignedToMaintainer(status = 'in_progress') {
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
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app!, maintainerId, ['MAINTAINER']);
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-TEST-${randomUUID()}`,
      status,
      assignedTo: maintainerId,
    });
    return { jobId, token, assignedTo: maintainerId };
  }

  it('PUT creates a part with a client-supplied id', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const partId = randomUUID();
    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'HEPA filter', quantity: 2, partNo: 'F-100' })
      .expect(200);
    expect(res.body.id).toBe(partId);
    expect(res.body.description).toBe('HEPA filter');
    expect(res.body.quantity).toBe(2);
    expect(res.body.partNo).toBe('F-100');
  });

  it('rejects a malformed (non-UUID) partId with 404, not a bare 500', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/abc`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'Gasket', quantity: 1 })
      .expect(404);
    expect(res.body).toMatchObject({ type: '/errors/not-found' });
  });

  it('rejects a PUT with no Idempotency-Key header (required here, unlike POST /jobs/{id}/parts)', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const partId = randomUUID();
    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .send({ description: 'Gasket', quantity: 1 })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/validation-failed' });

    const { rows } = await adminPool.query(`SELECT id FROM "part_used" WHERE id = $1`, [partId]);
    expect(rows).toHaveLength(0);
  });

  it('PUT updates the same part id (one row, new values)', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const partId = randomUUID();
    await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'HEPA filter', quantity: 2 })
      .expect(200);

    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'HEPA filter', quantity: 5 })
      .expect(200);
    expect(res.body.id).toBe(partId);
    expect(res.body.quantity).toBe(5);

    const { rows } = await adminPool.query(`SELECT id FROM "part_used" WHERE id = $1`, [partId]);
    expect(rows).toHaveLength(1);
  });

  it('PUT active:false soft-removes (row stays, active=false, absent from GET job)', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const partId = randomUUID();
    await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'Gasket', quantity: 1 })
      .expect(200);

    await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'Gasket', quantity: 1, active: false })
      .expect(200);

    const { rows } = await adminPool.query(`SELECT active FROM "part_used" WHERE id = $1`, [
      partId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);

    const job = await request(app!.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    const partIds = (job.body.partsUsed ?? []).map((p: { id: string }) => p.id);
    expect(partIds).not.toContain(partId);
  });

  it('rejects a part edit when the job is not writable (e.g. submitted)', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer('submitted');
    const partId = randomUUID();
    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'Gasket', quantity: 1 })
      .expect(409);
    expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
  });

  it('rejects a partId that belongs to a different job (404, other job untouched)', async () => {
    const jobA = await makeInProgressJobAssignedToMaintainer();
    const jobB = await makeInProgressJobAssignedToMaintainer();
    const partIdOfB = randomUUID();

    await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobB.jobId}/parts/${partIdOfB}`)
      .set(...authHeader(jobB.token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'Belongs to job B', quantity: 1 })
      .expect(200);

    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobA.jobId}/parts/${partIdOfB}`)
      .set(...authHeader(jobA.token))
      .set('Idempotency-Key', randomUUID())
      .send({ description: 'Hijack attempt', quantity: 99, active: false })
      .expect(404);
    expect(res.body).toMatchObject({ type: '/errors/not-found' });

    const { rows } = await adminPool.query(
      `SELECT job_id, description, quantity, active FROM "part_used" WHERE id = $1`,
      [partIdOfB],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe(jobB.jobId);
    expect(rows[0].description).toBe('Belongs to job B');
    expect(Number(rows[0].quantity)).toBe(1);
    expect(rows[0].active).toBe(true);
  });

  it('is idempotent on replay with the same Idempotency-Key (one row, ONE audit event — a re-applied PUT would write two)', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const partId = randomUUID();
    const key = randomUUID();
    const body = { description: 'Gasket', quantity: 3 };

    const first = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);

    const second = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);

    expect(second.body).toEqual(first.body);
    const { rows } = await adminPool.query(`SELECT id FROM "part_used" WHERE id = $1`, [partId]);
    expect(rows).toHaveLength(1);

    // A genuine replay short-circuits in `checkReplay`, before the
    // transaction (and its `audit.record` call) ever runs. A NON-replayed
    // second PUT (e.g. the `checkReplay` short-circuit deleted from
    // `upsertPart`) would instead re-run the upsert as an `update` and write
    // a second audit_event — this is the assertion that actually
    // distinguishes "replayed" from "just happened to produce the same
    // response" (mirrors approval-void-post-archive.spec.ts's "no second
    // step, no second audit").
    const audit = await adminPool.query(
      `SELECT count(*)::int AS n FROM "audit_event" WHERE entity_type = 'part_used' AND entity_id = $1`,
      [partId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('rejects the same Idempotency-Key reused with a different body (422 idempotency-mismatch)', async () => {
    const { jobId, token } = await makeInProgressJobAssignedToMaintainer();
    const partId = randomUUID();
    const key = randomUUID();

    await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ description: 'Gasket', quantity: 3 })
      .expect(200);

    const res = await request(app!.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', key)
      .send({ description: 'Gasket', quantity: 4 })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/idempotency-mismatch' });
  });
});
