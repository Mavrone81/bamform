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
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { realJpegBytes } from './helpers/image-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/** PR-034/PR-067 — functional attachment behaviour beyond the security cases. */
describe('Jobs — POST /jobs/{id}/attachments (functional)', () => {
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
    return { jobId, itemId, token };
  }

  it('requires Idempotency-Key', async () => {
    const { jobId, token } = await makeAssignedJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/attachments`)
      .set(...authHeader(token))
      .attach('file', realJpegBytes(), { filename: 'photo.jpg', contentType: 'image/jpeg' })
      .expect(422);
  });

  it('S-32: rejects an attachment over ATTACHMENT_MAX_BYTES (default 10 MB)', async () => {
    const { jobId, token } = await makeAssignedJob();
    const oversized = Buffer.concat([realJpegBytes(0), Buffer.alloc(10_485_761, 0xbb)]);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/attachments`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .attach('file', oversized, { filename: 'huge.jpg', contentType: 'image/jpeg' })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/attachment-rejected' });
  }, 20000);

  it('links an attachment to a specific item_result via itemResultId', async () => {
    const { jobId, itemId, token } = await makeAssignedJob();
    const itemResult = await request(app.getHttpServer())
      .put(`/api/v1/jobs/${jobId}/items/${itemId}`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'NOT_DONE', remark: 'see photo' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/attachments`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .field('itemResultId', itemResult.body.id)
      .attach('file', realJpegBytes(), { filename: 'photo.jpg', contentType: 'image/jpeg' })
      .expect(201);

    expect(res.body.itemResultId).toBe(itemResult.body.id);

    const job = await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    expect(job.body.attachments).toHaveLength(1);
    expect(job.body.attachments[0].id).toBe(res.body.id);
  });

  it('rejects an itemResultId that does not belong to this job', async () => {
    const { jobId, token } = await makeAssignedJob();
    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/attachments`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .field('itemResultId', randomUUID())
      .attach('file', realJpegBytes(), { filename: 'photo.jpg', contentType: 'image/jpeg' })
      .expect(404);
  });

  it('ATTACHMENT_MAX_PER_JOB caps attachments per job (default 30)', async () => {
    const { jobId, token } = await makeAssignedJob();
    for (let i = 0; i < 30; i += 1) {
      await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/attachments`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .attach('file', realJpegBytes(10), { filename: `p${i}.jpg`, contentType: 'image/jpeg' })
        .expect(201);
    }

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/attachments`)
      .set(...authHeader(token))
      .set('Idempotency-Key', randomUUID())
      .attach('file', realJpegBytes(10), {
        filename: 'one-too-many.jpg',
        contentType: 'image/jpeg',
      })
      .expect(422);
    expect(res.body).toMatchObject({ type: '/errors/attachment-rejected' });

    const rows = await adminPool.query('SELECT count(*) FROM "attachment" WHERE job_id = $1', [
      jobId,
    ]);
    expect(Number(rows.rows[0].count)).toBe(30);
  }, 30000);
});
