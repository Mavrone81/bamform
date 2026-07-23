import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authResultSchema, jwksResponseSchema } from '@bamform/shared';
import { createLoginableUser } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

function extractCookie(res: request.Response, name: string): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.find((c) => c.startsWith(`${name}=`));
}

describe('Auth flow — login, /auth/me, logout, JWKS, deny-by-default', () => {
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

  it('GET /.well-known/jwks.json is public and publishes the Ed25519 verification key (PR-087)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/.well-known/jwks.json').expect(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(jwksResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('GET /api/v1/healthz remains public (deny-by-default must not lock out the existing probe)', async () => {
    await request(app.getHttpServer()).get('/api/v1/healthz').expect(200);
  });

  it('GET /auth/me without a token is rejected 401 /errors/unauthenticated (deny-by-default, PR-SEC-05)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(res.body).toMatchObject({ type: '/errors/unauthenticated' });
  });

  it('sets the refresh cookie with HttpOnly, Secure, SameSite=Strict and the scoped Path (SEC §10.3)', async () => {
    await createLoginableUser({
      email: 'cookie@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['MAINTAINER'],
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cookie@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);

    const cookie = extractCookie(res, 'bf_refresh');
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('login → /auth/me → logout → the same access token jti is refused afterwards (PR-088 denylist)', async () => {
    await createLoginableUser({
      email: 'flow@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Flow Test User',
      roleCodes: ['TEAM_LEADER'],
    });
    const server = app.getHttpServer();

    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'flow@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    expect(authResultSchema.safeParse(loginRes.body).success).toBe(true);
    const accessToken = loginRes.body.accessToken as string;
    expect(loginRes.body.user).toMatchObject({
      fullName: 'Flow Test User',
      roles: ['TEAM_LEADER'],
    });

    const meRes = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(meRes.body).toMatchObject({ fullName: 'Flow Test User', roles: ['TEAM_LEADER'] });

    await request(server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    // Same (still-unexpired) access token must now be refused — PR-088.
    const afterLogout = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
    expect(afterLogout.body).toMatchObject({ type: '/errors/unauthenticated' });
  });

  it('logout revokes the refresh family too — a subsequent refresh is rejected', async () => {
    await createLoginableUser({
      email: 'logout-refresh@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['MAINTAINER'],
    });
    const server = app.getHttpServer();

    const loginRes = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: 'logout-refresh@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;
    const refreshCookie = extractCookie(loginRes, 'bf_refresh')?.split(';')[0] as string;

    await request(server)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', refreshCookie)
      .expect(204);

    await request(server).post('/api/v1/auth/refresh').set('Cookie', refreshCookie).expect(401);

    const revoked = await adminPool.query(
      `SELECT revoked_reason FROM "refresh_token" WHERE revoked_at IS NOT NULL`,
    );
    expect(revoked.rows.every((r) => r.revoked_reason === 'logout')).toBe(true);
  });
});
