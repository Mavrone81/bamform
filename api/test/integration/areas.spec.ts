import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createArea, createUser, grantRole } from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

describe('Areas — GET/POST /areas, GET/PATCH /areas/{id}', () => {
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
    const userId = await createUser('admin');
    await grantRole(userId, 'ADMIN');
    return mintAccessToken(app, userId, ['ADMIN']);
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/areas').expect(401);
  });

  it('ADMIN creates an area, and it is readable afterwards', async () => {
    const token = await adminToken();
    const code = `AREA-${randomUUID()}`;

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/areas')
      .set(...authHeader(token))
      .send({ code, name: 'Wire Bond Floor' })
      .expect(201);

    expect(createRes.body).toMatchObject({ code, name: 'Wire Bond Floor', active: true });

    const getRes = await request(app.getHttpServer())
      .get(`/api/v1/areas/${createRes.body.id}`)
      .set(...authHeader(token))
      .expect(200);
    expect(getRes.body).toMatchObject({ id: createRes.body.id, code });
  });

  it('writes an audit_event in the same transaction as area creation (PR-098)', async () => {
    const token = await adminToken();
    const code = `AREA-${randomUUID()}`;

    const res = await request(app.getHttpServer())
      .post('/api/v1/areas')
      .set(...authHeader(token))
      .send({ code, name: 'Audited Area' })
      .expect(201);

    const audit = await adminPool.query(
      `SELECT * FROM "audit_event" WHERE entity_type = 'area' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe('create');
  });

  it('a non-ADMIN role is forbidden from creating an area', async () => {
    const userId = await createUser('maintainer');
    await grantRole(userId, 'MAINTAINER');
    const token = await mintAccessToken(app, userId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .post('/api/v1/areas')
      .set(...authHeader(token))
      .send({ code: `AREA-${randomUUID()}`, name: 'Should not exist' })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('rejects a duplicate area code with 409', async () => {
    const token = await adminToken();
    const code = `AREA-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/api/v1/areas')
      .set(...authHeader(token))
      .send({ code, name: 'First' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/areas')
      .set(...authHeader(token))
      .send({ code, name: 'Duplicate' })
      .expect(409);
  });

  it('GET /areas/{id} 404s for an unknown id', async () => {
    const token = await adminToken();
    await request(app.getHttpServer())
      .get(`/api/v1/areas/${randomUUID()}`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('ADMIN can PATCH an area (deactivation, not deletion — PR-039)', async () => {
    const token = await adminToken();
    const areaId = await createArea(`AREA-${randomUUID()}`);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/areas/${areaId}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(200);
    expect(res.body).toMatchObject({ id: areaId, active: false });
  });

  it('a non-ADMIN role is forbidden from PATCHing an area', async () => {
    const areaId = await createArea(`AREA-${randomUUID()}`);
    const userId = await createUser('engineer');
    await grantRole(userId, 'ENGINEER');
    const token = await mintAccessToken(app, userId, ['ENGINEER']);

    await request(app.getHttpServer())
      .patch(`/api/v1/areas/${areaId}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(403);
  });

  it('lists areas with cursor pagination shape', async () => {
    const token = await adminToken();
    await createArea(`AREA-${randomUUID()}`);
    await createArea(`AREA-${randomUUID()}`);

    const res = await request(app.getHttpServer())
      .get('/api/v1/areas?limit=1')
      .set(...authHeader(token))
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toMatchObject({ hasMore: true, limit: 1 });
    expect(typeof res.body.page.nextCursor).toBe('string');
  });
});
