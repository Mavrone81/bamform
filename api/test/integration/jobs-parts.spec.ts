import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/** PR-033/UR-034 — parts consumed per job. No DELETE (non-negotiable #7). */
describe('Jobs — POST /jobs/{id}/parts', () => {
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
    return { jobId, token };
  }

  it('records a part and writes audit_event (non-negotiable #3)', async () => {
    const { jobId, token } = await makeAssignedJob();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set(...authHeader(token))
      .send({ partNo: 'FLT-100', description: 'Inlet filter', quantity: 2, remarks: 'both sides' })
      .expect(201);

    expect(res.body).toMatchObject({
      partNo: 'FLT-100',
      description: 'Inlet filter',
      quantity: 2,
      remarks: 'both sides',
    });

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'part_used' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]?.action).toBe('create');
  });

  it('has no DELETE endpoint (BUILD_HANDOFF non-negotiable #7)', async () => {
    const { jobId, token } = await makeAssignedJob();
    const created = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set(...authHeader(token))
      .send({ description: 'Gasket', quantity: 1 })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/v1/jobs/${jobId}/parts/${created.body.id}`)
      .set(...authHeader(token))
      .expect(404); // no such route registered at all
  });

  it('rejects parts on a job that is not ASSIGNED/IN_PROGRESS', async () => {
    const authorId = await createUser('author2');
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
    const maintainerId = await createUser('maintainer2');
    await grantRole(maintainerId, 'MAINTAINER');
    const token = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
    const jobId = await createJob({
      assetId,
      templateRevisionId: revisionId,
      approvalRouteId,
      jobNumber: `PM-SCHEDULED-${randomUUID()}`,
      status: 'scheduled',
      assignedTo: maintainerId,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/parts`)
      .set(...authHeader(token))
      .send({ description: 'Gasket', quantity: 1 })
      .expect(409);
    expect(res.body).toMatchObject({ type: '/errors/invalid-transition' });
  });
});
