/**
 * Slice 13-TL — the two bounded API additions the TLP load requires
 * (TEST_PLAN I-TL-25..27):
 *
 *   POST /templates       — PR-TLP-07: template shells are created through
 *                           the authenticated API (audited, attributable),
 *                           ENGINEER/DOC_CONTROLLER only, 409 on INV-07.
 *   GET  /approval-routes — read-only seeded reference data, so
 *                           POST /asset-types' approvalRouteId is resolvable
 *                           over HTTP.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../helpers/app';
import { adminPool, closeAll, resetDatabase } from '../helpers/db';
import { createUser, grantRole } from '../helpers/fixtures';
import { authHeader, mintAccessToken } from '../helpers/test-auth';
import { closeRedis } from '../helpers/redis';

describe('slice 13-TL API additions (I-TL-25..27)', () => {
  let app: INestApplication;
  let docControllerToken: string;
  let maintainerToken: string;

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
    const docControllerId = await createUser('doc.controller');
    await grantRole(docControllerId, 'DOC_CONTROLLER');
    docControllerToken = await mintAccessToken(app, docControllerId, ['DOC_CONTROLLER']);
    const maintainerId = await createUser('maintainer');
    await grantRole(maintainerId, 'MAINTAINER');
    maintainerToken = await mintAccessToken(app, maintainerId, ['MAINTAINER']);
  });

  it('I-TL-25: POST /templates creates the shell (201), writes an audit event, and 409s on a duplicate document number (INV-07) — never a silent upsert', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/templates')
      .set(...authHeader(docControllerToken))
      .send({ documentNumber: 'CE 95 020 00 01', title: 'ASM Wire Bond PM Record' })
      .expect(201);
    expect(created.body).toMatchObject({
      documentNumber: 'CE 95 020 00 01',
      title: 'ASM Wire Bond PM Record',
      active: true,
      currentRevisionId: null,
    });

    const audit = await adminPool.query(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE entity_type = 'form_template' AND action = 'create' AND entity_id = $1`,
      [created.body.id],
    );
    expect(audit.rows[0].n).toBe(1);

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/templates')
      .set(...authHeader(docControllerToken))
      .send({ documentNumber: 'CE 95 020 00 01', title: 'Different title' })
      .expect(409);
    expect(conflict.body.detail).toContain('CE 95 020 00 01');
  });

  it('I-TL-26: POST /templates is role-gated (MAINTAINER 403; missing auth 401; invalid body 422 with no row created)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/templates')
      .set(...authHeader(maintainerToken))
      .send({ documentNumber: 'CE 95 099 00 01', title: 'Nope' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/templates')
      .send({ documentNumber: 'CE 95 099 00 01', title: 'Nope' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/templates')
      .set(...authHeader(docControllerToken))
      .send({ documentNumber: '   ', title: '' })
      .expect(422);

    const count = await adminPool.query(`SELECT count(*)::int AS n FROM form_template`);
    expect(count.rows[0].n).toBe(0);
  });

  it('I-TL-27: GET /approval-routes returns the seeded route to any authenticated user, and 401 unauthenticated', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/approval-routes')
      .set(...authHeader(maintainerToken))
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const codes = res.body.map((r: { code: string }) => r.code);
    expect(codes).toContain('TWO_STAGE_TL_THEN_ENG');
    // The code must not lie about the route's shape (slice 26-TWOSTAGE): the
    // delivered route really is two stages, TEAM_LEADER then ENGINEER.
    expect(codes).not.toContain('SINGLE_STAGE_TL_OR_ENG');
    expect(res.body[0]).toMatchObject({ active: true });
    expect(typeof res.body[0].id).toBe('string');

    await request(app.getHttpServer()).get('/api/v1/approval-routes').expect(401);
  });
});
