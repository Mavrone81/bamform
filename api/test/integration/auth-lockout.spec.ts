import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createLoginableUser } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

describe('S-09 account lockout after repeated failed logins (PR-092, threat S-5)', () => {
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

  it('locks the account after 5 failed attempts and rejects the 6th with 429 + Retry-After, backoff applied', async () => {
    const { userId } = await createLoginableUser({
      email: 's09@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['MAINTAINER'],
    });
    const server = app.getHttpServer();

    // LOGIN_MAX_ATTEMPTS default is 5 — attempts 1-4 are plain 401s. The 5th
    // wrong attempt is the one that CROSSES the threshold: the account is
    // locked as a direct result of it, so that response is already 429, not
    // a 401 followed by a separate lockout on the next try.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 's09@bevorasg.com', password: 'definitely-the-wrong-password' })
        .expect(401);
      expect(res.body).toMatchObject({ type: '/errors/unauthenticated' });
    }

    const fifth = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's09@bevorasg.com', password: 'definitely-the-wrong-password' })
      .expect(429);
    expect(fifth.body).toMatchObject({ type: '/errors/rate-limited' });
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(0);

    const afterFive = await adminPool.query(
      `SELECT failed_login_count, locked_until FROM "app_user" WHERE id = $1`,
      [userId],
    );
    expect(afterFive.rows[0].failed_login_count).toBe(5);
    expect(afterFive.rows[0].locked_until).not.toBeNull();
    expect(new Date(afterFive.rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());

    // 6th attempt: account is locked — 429, not 401, with Retry-After.
    const sixth = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's09@bevorasg.com', password: 'definitely-the-wrong-password' })
      .expect(429);
    expect(sixth.body).toMatchObject({ type: '/errors/rate-limited' });
    expect(sixth.headers['retry-after']).toBeDefined();
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);

    // Even the CORRECT password is refused while locked (not merely rate-limited by IP).
    const correctWhileLocked = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's09@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(429);
    expect(correctWhileLocked.body).toMatchObject({ type: '/errors/rate-limited' });

    const lockoutAudit = await adminPool.query(
      `SELECT after FROM "audit_event"
       WHERE entity_type = 'app_user' AND entity_id = $1 AND after->>'event' = 'login_failed_lockout'`,
      [userId],
    );
    expect(lockoutAudit.rowCount).toBe(1);
  });
});
