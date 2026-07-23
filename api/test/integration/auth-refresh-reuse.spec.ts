import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createLoginableUser } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

function extractCookie(res: request.Response, name: string): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.find((c) => c.startsWith(`${name}=`))?.split(';')[0];
}

describe('S-06 refresh token reuse detection (PR-084, threat S-2)', () => {
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

  it('replaying an already-rotated refresh token revokes the whole family and writes a security audit event', async () => {
    await createLoginableUser({
      email: 's06@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['MAINTAINER'],
    });

    const server = app.getHttpServer();

    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 's06@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const originalCookie = extractCookie(loginRes, 'bf_refresh');
    expect(originalCookie).toBeDefined();

    // Legitimate rotation.
    const rotated = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', originalCookie as string)
      .expect(200);
    const rotatedCookie = extractCookie(rotated, 'bf_refresh');
    expect(rotatedCookie).toBeDefined();
    expect(rotatedCookie).not.toBe(originalCookie);

    // Reuse: the ORIGINAL (already-spent) token is presented again.
    const reuse = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', originalCookie as string)
      .expect(401);
    expect(reuse.body).toMatchObject({ type: '/errors/unauthenticated' });

    // The legitimately-rotated token must ALSO now be rejected — reuse
    // revokes the ENTIRE family, not just the replayed token.
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookie as string)
      .expect(401);

    const revoked = await adminPool.query(
      `SELECT revoked_reason FROM "refresh_token" WHERE revoked_at IS NOT NULL`,
    );
    expect(revoked.rowCount).toBeGreaterThanOrEqual(2);
    expect(revoked.rows.every((row) => row.revoked_reason === 'reuse_detected')).toBe(true);

    const auditRows = await adminPool.query(
      `SELECT action, entity_type, after FROM "audit_event" WHERE entity_type = 'refresh_token'`,
    );
    expect(auditRows.rowCount).toBe(1);
    expect(auditRows.rows[0].action).toBe('login_failed');
    expect(auditRows.rows[0].after).toMatchObject({ event: 'refresh_reuse_detected' });
  });
});
