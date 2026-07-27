import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * PR-095/AC-11 — `GET /records/{id}/integrity`. Also exercises S-10 (TEST_PLAN.md
 * §9, threat T-1: "alter an archived record directly in the database, run
 * /records/{id}/integrity — reported as mismatch") — previously a tracked
 * `test.todo` in `test/security/pending-cases.spec.ts` because no
 * records/integrity endpoint existed; it does now.
 */
describe('GET /records/{id}/integrity (PR-095, S-10)', () => {
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

  it('404s for a record that does not exist', async () => {
    const someone = await createUser('reader');
    await grantRole(someone, 'ADMIN');
    const token = await mintAccessToken(app, someone, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${randomUUID()}/integrity`)
      .set(...authHeader(token))
      .expect(404);
    expect(res.body).toMatchObject({ type: '/errors/not-found' });
  });

  it('reports intact:true and no signatures for a job that has never been through approval', async () => {
    const { jobId } = await createJobFixture(`PM-INTEGRITY-EMPTY-${randomUUID()}`, 'in_progress');
    const someone = await createUser('reader-2');
    await grantRole(someone, 'ADMIN');
    const token = await mintAccessToken(app, someone, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(token))
      .expect(200);
    expect(res.body).toMatchObject({ recordId: jobId, intact: true, signatures: [] });
  });

  // ------------------------------------------------------------- SYS-9
  // (system-review-2026-07-27): before slice 15-SYSWIRE this was the ONLY
  // record read with no object-level authorisation — any authenticated user
  // could probe arbitrary UUIDs and learn record existence, approval-step
  // ids/timestamps, signingKeyId and mismatchDetail (IDOR).

  it('SYS-9: a MAINTAINER cannot probe the integrity of a record NOT assigned to them — 403', async () => {
    const { jobId } = await createJobFixture(`PM-IDOR-${randomUUID()}`, 'archived', {
      archivedAt: new Date(),
    });
    const outsider = await createUser('maintainer-outsider');
    await grantRole(outsider, 'MAINTAINER');
    const token = await mintAccessToken(app, outsider, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(token))
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
    // Nothing about the record leaks in the rejection.
    expect(JSON.stringify(res.body)).not.toContain('signingKeyId');
  });

  it('SYS-9: a MAINTAINER CAN check integrity of their own assigned record ("View archive: own", §4.1)', async () => {
    const ownerId = await createUser('maintainer-owner');
    await grantRole(ownerId, 'MAINTAINER');
    const { jobId } = await createJobFixture(`PM-IDOR-OWN-${randomUUID()}`, 'archived', {
      assignedTo: ownerId,
      archivedAt: new Date(),
    });
    const token = await mintAccessToken(app, ownerId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(token))
      .expect(200);
    expect(res.body).toMatchObject({ recordId: jobId, intact: true });
  });

  it('SYS-9/PR-API-10: an area-scoped TEAM_LEADER cannot probe a record outside their scope — 403 out-of-scope', async () => {
    const areaA = await createArea(`IA-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`IB-${randomUUID().slice(0, 8)}`);
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
      jobNumber: `PM-IDOR-SCOPE-${randomUUID()}`,
      status: 'archived',
      archivedAt: new Date(),
    });

    const tlId = await createUser('tl-scoped-integrity');
    await grantRole(tlId, 'TEAM_LEADER');
    await scopeUserToArea(tlId, areaA);
    const token = await mintAccessToken(app, tlId, ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(token))
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/out-of-scope' });
  });

  it('S-10: tampering with a stored content_hash directly in the database is detected as a mismatch', async () => {
    const maintainerId = await createUser('maintainer-tamper');
    await grantRole(maintainerId, 'MAINTAINER');
    const { jobId } = await createJobFixture(`PM-TAMPER-${randomUUID()}`, 'submitted', {
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    const tlId = await createUser('tl-tamper');
    await grantRole(tlId, 'TEAM_LEADER');
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      tlId,
    ]);
    const tlToken = await mintAccessToken(app, tlId, ['TEAM_LEADER']);

    await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(tlToken))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(200);

    // Simulate an attacker (or a bug) editing the stored hash directly —
    // bypassing the application entirely, as S-10 specifies.
    await adminPool.query(
      `UPDATE "approval_step" SET content_hash = digest('tampered', 'sha256') WHERE job_id = $1`,
      [jobId],
    );

    const reader = await createUser('reader-3');
    await grantRole(reader, 'ADMIN');
    const readerToken = await mintAccessToken(app, reader, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(readerToken))
      .expect(200);
    expect(res.body.intact).toBe(false);
    expect(res.body.mismatchDetail).not.toBeNull();
    expect(res.body.signatures[0].signatureValid).toBe(false);
  });
});
