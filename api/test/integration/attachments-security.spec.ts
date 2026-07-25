import type { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createArea,
  createAsset,
  createAssetType,
  createFormTemplate,
  createJob,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
  scopeUserToArea,
} from './helpers/fixtures';
import { fakeJpegExecutableBytes, realJpegBytes } from './helpers/image-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * TEST_PLAN.md:
 *   S-19  (I-7)   Attachment URL requested by an unauthorised user  -> 403
 *   S-30  (§10.1) Upload a renamed executable as `.jpg`             -> rejected by magic-byte check
 *   I-INV-19 (PR-011) Attachment fetched by an unauthorised user    -> 403, object not served
 *
 * This is the security-critical pair the slice-6 brief names as the "done
 * when" gate. Real Postgres + MinIO (no mocks) — PR-034/PR-011/ADR-007.
 */
describe('Attachments — security (S-19, S-30, I-INV-19)', () => {
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

  async function makeAssignedJob(areaId?: string) {
    const authorId = await createUser('author');
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      areaId: areaId ?? null,
    });
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
    return { jobId, maintainerId, token };
  }

  describe('S-30 — magic-byte content validation', () => {
    it('rejects a renamed executable uploaded as .jpg — content sniffing, not extension/declared MIME', async () => {
      const { jobId, token } = await makeAssignedJob();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/attachments`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .attach('file', fakeJpegExecutableBytes(), {
          filename: 'photo.jpg',
          contentType: 'image/jpeg', // client-declared MIME — deliberately lying, must not be trusted
        })
        .expect(422);

      expect(res.body).toMatchObject({ type: '/errors/attachment-rejected' });

      const rows = await adminPool.query('SELECT count(*) FROM "attachment" WHERE job_id = $1', [
        jobId,
      ]);
      expect(Number(rows.rows[0].count)).toBe(0);
    });

    it('accepts a real JPEG with correct magic bytes', async () => {
      const { jobId, token } = await makeAssignedJob();
      const bytes = realJpegBytes();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/attachments`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .attach('file', bytes, { filename: 'photo.jpg', contentType: 'image/jpeg' })
        .expect(201);

      expect(res.body).toMatchObject({
        contentType: 'image/jpeg',
        byteSize: bytes.length,
        uploadState: 'received',
      });
      expect(res.body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
  });

  describe('S-19 / I-INV-19 — attachment fetch authorisation on EVERY access', () => {
    async function uploadOne(jobId: string, token: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/jobs/${jobId}/attachments`)
        .set(...authHeader(token))
        .set('Idempotency-Key', randomUUID())
        .attach('file', realJpegBytes(), { filename: 'photo.jpg', contentType: 'image/jpeg' })
        .expect(201);
      return res.body.id as string;
    }

    it('the assigned technician CAN fetch their own attachment (control case)', async () => {
      const { jobId, token } = await makeAssignedJob();
      const attachmentId = await uploadOne(jobId, token);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}/attachments/${attachmentId}`)
        .set(...authHeader(token))
        .expect(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(Buffer.from(res.body).equals(realJpegBytes())).toBe(true);
    });

    it('S-19: a MAINTAINER not assigned to the job is rejected 403 — object not served', async () => {
      const { jobId, token } = await makeAssignedJob();
      const attachmentId = await uploadOne(jobId, token);

      const otherId = await createUser('intruder');
      await grantRole(otherId, 'MAINTAINER');
      const otherToken = await mintAccessToken(app, otherId, ['MAINTAINER']);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}/attachments/${attachmentId}`)
        .set(...authHeader(otherToken))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/forbidden' });
      // The body is a JSON Problem, never image bytes — the object genuinely wasn't served.
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('I-INV-19: an ENGINEER scoped to a DIFFERENT area is rejected 403 out-of-scope — object not served', async () => {
      const areaA = await createArea(`AREA-${randomUUID()}`);
      const areaB = await createArea(`AREA-${randomUUID()}`);
      const { jobId, token } = await makeAssignedJob(areaB);
      const attachmentId = await uploadOne(jobId, token);

      const scopedId = await createUser('scoped-out');
      await grantRole(scopedId, 'ENGINEER');
      await scopeUserToArea(scopedId, areaA);
      const scopedToken = await mintAccessToken(app, scopedId, ['ENGINEER']);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}/attachments/${attachmentId}`)
        .set(...authHeader(scopedToken))
        .expect(403);
      expect(res.body).toMatchObject({ type: '/errors/out-of-scope' });
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('rejects fetching an unauthenticated request entirely (401, before any authorisation logic runs)', async () => {
      const { jobId, token } = await makeAssignedJob();
      const attachmentId = await uploadOne(jobId, token);

      await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobId}/attachments/${attachmentId}`)
        .expect(401);
    });

    it('404s for an attachment id that does not belong to this job (no cross-job leak via a guessed id)', async () => {
      const { jobId: jobA, token: tokenA } = await makeAssignedJob();
      const { jobId: jobB, token: tokenB } = await makeAssignedJob();
      const attachmentInB = await uploadOne(jobB, tokenB);

      await request(app.getHttpServer())
        .get(`/api/v1/jobs/${jobA}/attachments/${attachmentInB}`)
        .set(...authHeader(tokenA))
        .expect(404);
    });
  });
});
