import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createDelegation, createJobFixture, createUser, grantRole } from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { realPngDataUrl } from './helpers/image-fixtures';

/**
 * PR-076 delegation resolution + S-25 (TEST_PLAN.md, threat E-5): "act under
 * an expired delegation — not permitted." Delegation is NOT a role-bypass
 * mechanism (the route-level `@Roles('TEAM_LEADER','ENGINEER')` guard already
 * requires the actor to hold an eligible role, regardless of `onBehalfOf` —
 * see `VerificationService#resolveEligibility`'s doc comment); every actor
 * below already holds TEAM_LEADER on their own. What delegation controls is
 * whether the `onBehalfOf` CLAIM — "I acted in place of this specific absent
 * colleague" — is honoured: only while a currently-active, non-revoked
 * `delegation` row from that colleague exists.
 */
describe('Jobs — POST /jobs/{id}/verify onBehalfOf (PR-076, S-25)', () => {
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
    const { jobId } = await createJobFixture(`PM-DELEG-${randomUUID()}`, 'submitted', {
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    return { jobId };
  }

  async function stepUpUser(label: string, roleCodes: string[]) {
    const userId = await createUser(label);
    for (const role of roleCodes) {
      await grantRole(userId, role);
    }
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      userId,
    ]);
    const token = await mintAccessToken(app, userId, roleCodes);
    return { userId, token };
  }

  it('S-25: an EXPIRED delegation is rejected — the onBehalfOf claim is not permitted, even though the actor holds an eligible role themselves', async () => {
    const { jobId } = await makeSubmittedJob();
    const delegator = await createUser('delegator-expired');
    // The actor DOES hold TEAM_LEADER — this is not a role-eligibility test.
    const delegate = await stepUpUser('delegate-expired', ['TEAM_LEADER']);
    const admin = await createUser('admin-creator');

    await createDelegation(delegator, delegate.userId, admin, {
      validFrom: new Date(Date.now() - 48 * 3600 * 1000),
      validTo: new Date(Date.now() - 24 * 3600 * 1000), // expired yesterday
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(delegate.token))
      .send({ drawnSignature: realPngDataUrl(), onBehalfOf: delegator })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });

    const stepCount = await adminPool.query(
      'SELECT count(*) FROM "approval_step" WHERE job_id = $1',
      [jobId],
    );
    expect(Number(stepCount.rows[0].count)).toBe(0);
  });

  it('S-25 variant: a REVOKED (but not yet expired) delegation is also rejected', async () => {
    const { jobId } = await makeSubmittedJob();
    const delegator = await createUser('delegator-revoked');
    const delegate = await stepUpUser('delegate-revoked', ['TEAM_LEADER']);
    const admin = await createUser('admin-creator-2');

    await createDelegation(delegator, delegate.userId, admin, {
      validFrom: new Date(Date.now() - 3600 * 1000),
      validTo: new Date(Date.now() + 24 * 3600 * 1000),
      revokedAt: new Date(),
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(delegate.token))
      .send({ drawnSignature: realPngDataUrl(), onBehalfOf: delegator })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('no delegation at all between the two users is rejected the same way', async () => {
    const { jobId } = await makeSubmittedJob();
    const delegator = await createUser('delegator-none');
    const delegate = await stepUpUser('delegate-none', ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(delegate.token))
      .send({ drawnSignature: realPngDataUrl(), onBehalfOf: delegator })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('a currently-ACTIVE, non-revoked delegation IS honoured — verify succeeds and persists both actor and on_behalf_of', async () => {
    const { jobId } = await makeSubmittedJob();
    const delegator = await createUser('delegator-active');
    const delegate = await stepUpUser('delegate-active', ['TEAM_LEADER']);
    const admin = await createUser('admin-creator-3');

    await createDelegation(delegator, delegate.userId, admin, {
      validFrom: new Date(Date.now() - 3600 * 1000),
      validTo: new Date(Date.now() + 24 * 3600 * 1000),
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(delegate.token))
      .send({ drawnSignature: realPngDataUrl(), onBehalfOf: delegator })
      .expect(200);
    expect(res.body.status).toBe('SUBMITTED'); // stage 1 of 2 — advances, does not archive

    const step = await adminPool.query(
      'SELECT actor_id, on_behalf_of_id, actor_role_code FROM "approval_step" WHERE job_id = $1',
      [jobId],
    );
    expect(step.rows[0]).toMatchObject({
      actor_id: delegate.userId,
      on_behalf_of_id: delegator,
      actor_role_code: 'TEAM_LEADER',
    });
  });

  it('a delegation for a DIFFERENT job stage/role pairing does not leak eligibility — actor still needs their own role for THIS stage', async () => {
    const { jobId } = await makeSubmittedJob(); // stage 1 requires TEAM_LEADER
    const delegator = await createUser('delegator-eng');
    // The actor only holds ENGINEER — not eligible for stage 1 regardless of delegation.
    const delegate = await stepUpUser('delegate-eng-only', ['ENGINEER']);
    const admin = await createUser('admin-creator-5');

    await createDelegation(delegator, delegate.userId, admin, {
      validFrom: new Date(Date.now() - 3600 * 1000),
      validTo: new Date(Date.now() + 24 * 3600 * 1000),
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/jobs/${jobId}/verify`)
      .set(...authHeader(delegate.token))
      .send({ drawnSignature: realPngDataUrl(), onBehalfOf: delegator })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });
});
