import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { closeAll, resetDatabase } from './helpers/db';
import { createJobFixture, createUser, grantRole } from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * S-24 (TEST_PLAN.md §9, threat E-4): "AUDITOR attempts any write — rejected;
 * connection is read-only." This slice wires the ROLE-GATE half against the
 * four new approval endpoints (`@Roles()` on `ApprovalController` never
 * lists `AUDITOR` — API_SPECIFICATION.md §4.1's permission matrix has
 * AUDITOR blank on every write row). The DATABASE-CONNECTION half of S-24
 * (`bamform_readonly`, PR-API-09) is a pre-existing, cross-cutting gap that
 * predates this slice (no endpoint in slices 1-6 routes AUDITOR traffic
 * through `bamform_readonly` either — see `pending-cases.spec.ts`'s history)
 * and is NOT solved here — see slice-7-report.md's concerns.
 */
describe('S-24 — AUDITOR cannot write via the new approval endpoints (threat E-4)', () => {
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

  async function makeSubmittedJob() {
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    const { jobId } = await createJobFixture(`PM-AUDITOR-${randomUUID()}`, 'submitted', {
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    return { jobId };
  }

  async function auditorToken() {
    const userId = await createUser('auditor');
    await grantRole(userId, 'AUDITOR');
    return mintAccessToken(app, userId, ['AUDITOR']);
  }

  it('AUDITOR cannot verify', async () => {
    const { jobId } = await makeSubmittedJob();
    const token = await auditorToken();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(token))
      .send({ drawnSignature: realPngDataUrl() })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('AUDITOR cannot return', async () => {
    const { jobId } = await makeSubmittedJob();
    const token = await auditorToken();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/return`)
      .set(...authHeader(token))
      .send({ reason: 'attempted by an auditor account' })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('AUDITOR cannot recall', async () => {
    const { jobId } = await makeSubmittedJob();
    const token = await auditorToken();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/recall`)
      .set(...authHeader(token))
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('AUDITOR cannot void', async () => {
    const { jobId } = await makeSubmittedJob();
    const token = await auditorToken();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/void`)
      .set(...authHeader(token))
      .send({ reason: 'attempted by an auditor account' })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('AUDITOR CAN read — GET /jobs/{id}/integrity-adjacent read paths remain permitted (read-only, not no-access)', async () => {
    const { jobId } = await makeSubmittedJob();
    const token = await auditorToken();
    await request(app.getHttpServer())
      .get(`/api/v1/jobs/${jobId}`)
      .set(...authHeader(token))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/records/${jobId}/integrity`)
      .set(...authHeader(token))
      .expect(200);
  });
});
