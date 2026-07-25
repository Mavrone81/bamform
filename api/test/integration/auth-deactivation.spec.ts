import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createLoginableUser } from './helpers/auth-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

function extractCookie(res: request.Response, name: string): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.find((c) => c.startsWith(`${name}=`))?.split(';')[0];
}

/**
 * Security fix (post slice-13a review): `PATCH /users/{id}` setting
 * `status: deactivated` (UR-075) must actually deny access, not just flag
 * the row cosmetically — `auth.service.ts#login`/`#refresh` re-check
 * `status` so a deactivated user cannot obtain or refresh an access token.
 */
describe('Auth denies deactivated accounts (slice 13a follow-up, UR-075)', () => {
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

  async function adminToken(): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `admin-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Admin Actor',
      roleCodes: ['ADMIN'],
    });
    return mintAccessToken(app, userId, ['ADMIN']);
  }

  it('a deactivated user is denied login with the SAME opaque failure as invalid credentials', async () => {
    const admin = await adminToken();
    const { userId } = await createLoginableUser({
      email: 'deactivate-login@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Deactivated Login User',
      roleCodes: ['MAINTAINER'],
    });
    const server = app.getHttpServer();

    // Sanity: the account can log in while still active.
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'deactivate-login@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);

    await request(server)
      .patch(`/api/v1/users/${userId}`)
      .set(...authHeader(admin))
      .send({ active: false })
      .expect(200);

    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'deactivate-login@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(401);

    // Byte-for-byte the same problem body login already returns for a
    // wrong password — deactivation must not be a distinguishable oracle.
    expect(res.body).toMatchObject({
      type: '/errors/unauthenticated',
      detail: 'Email or password is incorrect.',
    });
    expect(res.body.accessToken).toBeUndefined();
  });

  it('a user deactivated after obtaining a refresh token is denied on refresh (no new access token minted)', async () => {
    const admin = await adminToken();
    const { userId } = await createLoginableUser({
      email: 'deactivate-refresh@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Deactivated Refresh User',
      roleCodes: ['MAINTAINER'],
    });
    const server = app.getHttpServer();

    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'deactivate-refresh@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const refreshCookie = extractCookie(loginRes, 'bf_refresh') as string;
    expect(refreshCookie).toBeDefined();

    await request(server)
      .patch(`/api/v1/users/${userId}`)
      .set(...authHeader(admin))
      .send({ active: false })
      .expect(200);

    const res = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(401);
    expect(res.body).toMatchObject({ type: '/errors/unauthenticated' });
    expect(res.body.accessToken).toBeUndefined();
  });

  it('an ACTIVE user still logs in and refreshes normally (no regression)', async () => {
    await createLoginableUser({
      email: 'still-active@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Still Active User',
      roleCodes: ['MAINTAINER'],
    });
    const server = app.getHttpServer();

    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'still-active@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    expect(loginRes.body.accessToken).toBeDefined();

    const refreshCookie = extractCookie(loginRes, 'bf_refresh') as string;
    const refreshRes = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .expect(200);
    expect(refreshRes.body.accessToken).toBeDefined();
  });
});
