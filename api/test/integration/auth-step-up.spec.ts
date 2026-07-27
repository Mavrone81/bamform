import { ConfigService } from '@nestjs/config';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StepUpGuard } from '../../src/auth/guards/step-up.guard';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createLoginableUser } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

function makeContext(userId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: userId } }) }),
  } as unknown as ExecutionContext;
}

describe('S-07/S-08 step-up authentication (PR-091, threat S-4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
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

  it('S-07 rejects with 403 /errors/step-up-required once the window has lapsed', async () => {
    const { userId } = await createLoginableUser({
      email: 's07@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    // STEP_UP_WINDOW_SECONDS default is 900s (15 min) — 20 minutes ago is stale.
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() - interval '20 minutes' WHERE id = $1`,
      [userId],
    );

    const guard = new StepUpGuard(prisma, new ConfigService({}));

    await expect(guard.canActivate(makeContext(userId))).rejects.toMatchObject({
      response: { type: '/errors/step-up-required', status: 403 },
    });
  });

  it('S-08 permits the request once the actor has authenticated within the window', async () => {
    const { userId } = await createLoginableUser({
      email: 's08@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      userId,
    ]);

    const guard = new StepUpGuard(prisma, new ConfigService({}));

    await expect(guard.canActivate(makeContext(userId))).resolves.toBe(true);
  });

  it('S-08 permits the request again after a successful POST /auth/step-up refreshes the window', async () => {
    const { userId } = await createLoginableUser({
      email: 's08b@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() - interval '20 minutes' WHERE id = $1`,
      [userId],
    );

    const guard = new StepUpGuard(prisma, new ConfigService({}));
    await expect(guard.canActivate(makeContext(userId))).rejects.toMatchObject({
      response: { type: '/errors/step-up-required' },
    });

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 's08b@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    const stepUpRes = await request(app.getHttpServer())
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'CorrectHorseBattery1!' })
      .expect(200);
    expect(new Date(stepUpRes.body.stepUpValidUntil).getTime()).toBeGreaterThan(Date.now());

    await expect(guard.canActivate(makeContext(userId))).resolves.toBe(true);

    const auditRows = await adminPool.query(
      `SELECT after FROM "audit_event" WHERE entity_type = 'app_user' AND after->>'event' = 'step_up_success'`,
    );
    expect(auditRows.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('POST /auth/step-up rejects a wrong password and writes a step_up_failed audit event', async () => {
    const { userId } = await createLoginableUser({
      email: 's08c@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 's08c@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'definitely-wrong' })
      .expect(401);

    // The step_up_failed event is still written; since CR-13 the SAME failed
    // attempt also feeds the shared lockout counter, which records its own
    // failure event after it — so assert presence, not last position.
    const auditRows = await adminPool.query(
      `SELECT after FROM "audit_event"
       WHERE entity_type = 'app_user' AND entity_id = $1 AND after->>'event' = 'step_up_failed'`,
      [userId],
    );
    expect(auditRows.rowCount).toBe(1);

    // CR-13: the failed step-up incremented the shared login-failure counter.
    const row = await adminPool.query(`SELECT failed_login_count FROM "app_user" WHERE id = $1`, [
      userId,
    ]);
    expect(row.rows[0].failed_login_count).toBe(1);
  });

  // ------------------------------------------------------------- CR-13
  // (crypto-review-2026-07-27): step-up was the ONE credential-checking path
  // that never fed the account-lockout counter — a stolen 15-min access token
  // (threat S-4: the unattended shop-floor tablet) allowed password guessing
  // at 10/min indefinitely, with no lockout and no symptom for the real user.
  // Step-up now shares `failed_login_count` with login and MFA, exactly as
  // `AccountLockoutService`'s header prescribes for every credential check.
  //
  // NOTE: this supersedes the earlier "S-08b rate-limit-only" test — with the
  // shared lockout, the 5th wrong password now locks the account (429) before
  // the 10/min rate limiter is ever reached; the rate limiter still fronts
  // the endpoint (last test below).

  it('CR-13: N failed step-ups lock the account exactly as N failed logins do — and the lock applies to LOGIN too (shared counter)', async () => {
    const { userId } = await createLoginableUser({
      email: 's08d@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    const server = app.getHttpServer();
    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's08d@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    // LOGIN_MAX_ATTEMPTS default 5 — attempts 1-4 run the real password
    // check and fail 401; the 5th crosses the threshold and is 429 directly
    // (same shape as auth-lockout.spec's login behaviour).
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await request(server)
        .post('/api/v1/auth/step-up')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: 'wrong-password-attempt' })
        .expect(401);
    }
    const fifth = await request(server)
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'wrong-password-attempt' })
      .expect(429);
    expect(fifth.body).toMatchObject({ type: '/errors/rate-limited' });
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(0);

    const row = await adminPool.query(
      `SELECT failed_login_count, locked_until FROM "app_user" WHERE id = $1`,
      [userId],
    );
    expect(row.rows[0].failed_login_count).toBe(5);
    expect(row.rows[0].locked_until).not.toBeNull();

    // Even the CORRECT password is refused while locked — step-up AND login.
    await request(server)
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'CorrectHorseBattery1!' })
      .expect(429);
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's08d@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(429);
  });

  it('CR-13: a successful step-up RESETS the shared failure counter (same convention as a successful login)', async () => {
    const { userId } = await createLoginableUser({
      email: 's08e@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    const server = app.getHttpServer();
    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's08e@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await request(server)
        .post('/api/v1/auth/step-up')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: 'wrong-password-attempt' })
        .expect(401);
    }
    const mid = await adminPool.query(`SELECT failed_login_count FROM "app_user" WHERE id = $1`, [
      userId,
    ]);
    expect(mid.rows[0].failed_login_count).toBe(3);

    await request(server)
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'CorrectHorseBattery1!' })
      .expect(200);

    const after = await adminPool.query(
      `SELECT failed_login_count, locked_until FROM "app_user" WHERE id = $1`,
      [userId],
    );
    expect(after.rows[0].failed_login_count).toBe(0);
    expect(after.rows[0].locked_until).toBeNull();
  });

  it('S-08b: the 10/min per-user rate limiter still fronts step-up — the 11th request in a minute is limited BEFORE any credential/lockout logic', async () => {
    await createLoginableUser({
      email: 's08f@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    const server = app.getHttpServer();
    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's08f@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    // 10 requests consume the window (the later ones answered by the
    // account lockout, which reports the lock, not the rate limit).
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await request(server)
        .post('/api/v1/auth/step-up')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: 'wrong-password-attempt' });
    }
    const eleventh = await request(server)
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'CorrectHorseBattery1!' })
      .expect(429);
    expect(eleventh.body).toMatchObject({ type: '/errors/rate-limited' });
    // The rate limiter's message, not the lockout's — proves the 429 came
    // from the per-minute window (checked FIRST), not the account lock.
    expect(eleventh.body.detail).toMatch(/Too many step-up attempts/);
  });
});
