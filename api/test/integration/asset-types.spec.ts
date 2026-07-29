import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createFormTemplate,
  createUser,
  getSeededApprovalRouteId,
  grantRole,
} from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

describe('Asset types — GET/POST /asset-types, GET/PATCH /asset-types/{id}', () => {
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

  async function engineerToken(): Promise<string> {
    const userId = await createUser('engineer');
    await grantRole(userId, 'ENGINEER');
    return mintAccessToken(app, userId, ['ENGINEER']);
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/asset-types').expect(401);
  });

  it('ENGINEER creates an asset type against a real approval_route (PR-019)', async () => {
    const token = await engineerToken();
    const approvalRouteId = await getSeededApprovalRouteId();
    const code = `AT-${randomUUID()}`;

    const res = await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code, name: 'ASM Wire Bond', approvalRouteId })
      .expect(201);

    expect(res.body).toMatchObject({
      code,
      approvalRouteId,
      leadTimeDays: 30,
      active: true,
    });
    // Slice 27-ASSETDOC: an asset type is the machine-family grouping and no
    // longer names a form. Which documents a MACHINE carries is
    // `GET /assets/{id}/documents`.
    expect(res.body).not.toHaveProperty('formTemplateId');
  });

  it('writes an audit_event in the same transaction as creation (PR-098)', async () => {
    const token = await engineerToken();
    const approvalRouteId = await getSeededApprovalRouteId();

    const res = await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code: `AT-${randomUUID()}`, name: 'X', approvalRouteId })
      .expect(201);

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'asset_type' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]?.action).toBe('create');
  });

  it('a MAINTAINER is forbidden from creating an asset type', async () => {
    const userId = await createUser('maintainer');
    await grantRole(userId, 'MAINTAINER');
    const token = await mintAccessToken(app, userId, ['MAINTAINER']);
    const approvalRouteId = await getSeededApprovalRouteId();

    await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code: `AT-${randomUUID()}`, name: 'X', approvalRouteId })
      .expect(403);
  });

  it('rejects a duplicate asset type code with 409', async () => {
    const token = await engineerToken();
    const approvalRouteId = await getSeededApprovalRouteId();
    const code = `AT-${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code, name: 'First', approvalRouteId })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code, name: 'Second', approvalRouteId })
      .expect(409);
  });

  it('slice 27: two asset types may now exist for the same document — the 1:1 rule is GONE', async () => {
    // This test is the INVERSE of the slice-1 one it replaces. `asset_type`
    // used to carry `form_template_id UNIQUE`, so a second machine family
    // referencing the same document was a 409. That is precisely the rule the
    // owner's schedule contradicts: CM02 and CM03 both use CE 95 030 00 01,
    // and T8, T69 and ST01 all use CE 95 050 00 01. Asset types no longer
    // reference a document at all, so there is nothing left to collide.
    const token = await engineerToken();
    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);

    const first = await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code: `AT-${randomUUID()}`, name: 'First', approvalRouteId })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code: `AT-${randomUUID()}`, name: 'Second', approvalRouteId })
      .expect(201);

    // A stray `formTemplateId` in the body is ignored, not an error — it is
    // simply not part of the contract any more.
    await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code: `AT-${randomUUID()}`, name: 'Third', formTemplateId, approvalRouteId })
      .expect(201);

    expect(first.body).not.toHaveProperty('formTemplateId');
  });

  it('GET /asset-types/{id} 404s for an unknown id, 200s for a known one', async () => {
    const token = await engineerToken();
    const approvalRouteId = await getSeededApprovalRouteId();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(token))
      .send({ code: `AT-${randomUUID()}`, name: 'X', approvalRouteId })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/asset-types/${createRes.body.id}`)
      .set(...authHeader(token))
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/asset-types/${randomUUID()}`)
      .set(...authHeader(token))
      .expect(404);
  });

  it('ADMIN can PATCH leadTimeDays and deactivate (PR-039)', async () => {
    const engineer = await engineerToken();
    const approvalRouteId = await getSeededApprovalRouteId();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/asset-types')
      .set(...authHeader(engineer))
      .send({ code: `AT-${randomUUID()}`, name: 'X', approvalRouteId })
      .expect(201);

    const adminId = await createUser('admin');
    await grantRole(adminId, 'ADMIN');
    const adminToken = await mintAccessToken(app, adminId, ['ADMIN']);

    const patchRes = await request(app.getHttpServer())
      .patch(`/api/v1/asset-types/${createRes.body.id}`)
      .set(...authHeader(adminToken))
      .send({ leadTimeDays: 45, active: false })
      .expect(200);

    expect(patchRes.body).toMatchObject({ leadTimeDays: 45, active: false });
  });
});
