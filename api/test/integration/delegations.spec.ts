import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createLoginableUser } from './helpers/auth-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * PR-038/PR-076/UR-052 — `GET/POST /delegations`, `DELETE /delegations/{id}`
 * (soft-revoke). Uses `createLoginableUser` (real AES-256-GCM encryption),
 * not the plain `createUser` fixture — every delegation response decrypts
 * both parties' `full_name_ct` (`delegations.mapper.ts#toDelegation`,
 * the same precedent `current-user.builder.ts#buildCurrentUser` already
 * established), which fails against `createUser`'s placeholder bytes.
 */
describe('Delegations — GET/POST /delegations, DELETE /delegations/{id} (PR-038/076/UR-052)', () => {
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

  async function realUser(label: string, roleCodes: string[] = []) {
    const { userId } = await createLoginableUser({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'correct horse battery staple',
      fullName: `${label} Full Name`,
      roleCodes,
    });
    const token = await mintAccessToken(app, userId, roleCodes);
    return { userId, token };
  }

  it('POST creates a delegation — TEAM_LEADER delegating their OWN authority', async () => {
    const tl = await realUser('tl', ['TEAM_LEADER']);
    const delegate = await realUser('delegate', ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(tl.token))
      .send({
        delegatorId: tl.userId,
        delegateId: delegate.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
        reason: 'annual leave',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      delegatorId: tl.userId,
      delegateId: delegate.userId,
      delegatorName: 'tl Full Name',
      delegateName: 'delegate Full Name',
      createdBy: tl.userId,
      revokedAt: null,
    });

    const row = await adminPool.query('SELECT created_by FROM "delegation" WHERE id = $1', [
      res.body.id,
    ]);
    expect(row.rows[0].created_by).toBe(tl.userId);

    const audit = await adminPool.query(
      `SELECT action, entity_type, entity_id FROM "audit_event" WHERE entity_type = 'delegation' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows).toEqual([
      { action: 'create', entity_type: 'delegation', entity_id: res.body.id },
    ]);
  });

  it("a TEAM_LEADER/ENGINEER cannot create a delegation delegating SOMEONE ELSE'S authority", async () => {
    const tl = await realUser('tl2', ['TEAM_LEADER']);
    const otherDelegator = await realUser('other-delegator', ['TEAM_LEADER']);
    const delegate = await realUser('delegate2', ['TEAM_LEADER']);

    const res = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(tl.token))
      .send({
        delegatorId: otherDelegator.userId,
        delegateId: delegate.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('ADMIN may create a delegation between two OTHER users', async () => {
    const admin = await realUser('admin', ['ADMIN']);
    const delegator = await realUser('delegator3', ['ENGINEER']);
    const delegate = await realUser('delegate3', ['ENGINEER']);

    await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(admin.token))
      .send({
        delegatorId: delegator.userId,
        delegateId: delegate.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);
  });

  it('rejects delegating to oneself (422 — validation)', async () => {
    const tl = await realUser('tl-self', ['TEAM_LEADER']);
    const res = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(tl.token))
      .send({
        delegatorId: tl.userId,
        delegateId: tl.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(422);
    expect(res.body.type).toBe('/errors/validation-failed');
  });

  it('a MAINTAINER cannot create a delegation at all (route-level @Roles)', async () => {
    const maintainer = await realUser('maint', ['MAINTAINER']);
    const other = await realUser('other4', ['TEAM_LEADER']);
    await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(maintainer.token))
      .send({
        delegatorId: maintainer.userId,
        delegateId: other.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(403);
  });

  it("GET returns the caller's grants AND grants made to them, excludes unrelated delegations", async () => {
    const a = await realUser('a', ['TEAM_LEADER']);
    const b = await realUser('b', ['TEAM_LEADER']);
    const stranger = await realUser('stranger', ['TEAM_LEADER']);

    // a -> b (a is delegator)
    await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(a.token))
      .send({
        delegatorId: a.userId,
        delegateId: b.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);

    // b -> a (b is delegator, a is delegate) — via ADMIN so ownership rule doesn't block it
    const admin = await realUser('admin2', ['ADMIN']);
    await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(admin.token))
      .send({
        delegatorId: b.userId,
        delegateId: a.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);

    // stranger's own, unrelated delegation
    await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(stranger.token))
      .send({
        delegatorId: stranger.userId,
        delegateId: b.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/delegations')
      .set(...authHeader(a.token))
      .expect(200);

    expect(res.body.data).toHaveLength(2); // a->b and b->a, not stranger->b
    const pairs = res.body.data.map((d: { delegatorId: string; delegateId: string }) => [
      d.delegatorId,
      d.delegateId,
    ]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [a.userId, b.userId],
        [b.userId, a.userId],
      ]),
    );
  });

  it('DELETE soft-revokes — sets revokedAt, the row still exists (no hard delete, INV)', async () => {
    const tl = await realUser('tl-revoke', ['TEAM_LEADER']);
    const delegate = await realUser('delegate-revoke', ['TEAM_LEADER']);

    const created = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(tl.token))
      .send({
        delegatorId: tl.userId,
        delegateId: delegate.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);

    const revoked = await request(app.getHttpServer())
      .delete(`/api/v1/delegations/${created.body.id}`)
      .set(...authHeader(tl.token))
      .expect(200);
    expect(revoked.body.revokedAt).not.toBeNull();

    const row = await adminPool.query('SELECT revoked_at FROM "delegation" WHERE id = $1', [
      created.body.id,
    ]);
    expect(row.rows).toHaveLength(1); // row is still present
    expect(row.rows[0].revoked_at).not.toBeNull();
  });

  it('revoking is idempotent — a second DELETE on an already-revoked delegation succeeds unchanged', async () => {
    const tl = await realUser('tl-revoke2', ['TEAM_LEADER']);
    const delegate = await realUser('delegate-revoke2', ['TEAM_LEADER']);
    const created = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(tl.token))
      .send({
        delegatorId: tl.userId,
        delegateId: delegate.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/v1/delegations/${created.body.id}`)
      .set(...authHeader(tl.token))
      .expect(200);
    const second = await request(app.getHttpServer())
      .delete(`/api/v1/delegations/${created.body.id}`)
      .set(...authHeader(tl.token))
      .expect(200);
    expect(second.body.revokedAt).not.toBeNull();
  });

  it("an unrelated user cannot revoke someone else's delegation", async () => {
    const tl = await realUser('tl-revoke3', ['TEAM_LEADER']);
    const delegate = await realUser('delegate-revoke3', ['TEAM_LEADER']);
    const stranger = await realUser('stranger-revoke', ['TEAM_LEADER']);

    const created = await request(app.getHttpServer())
      .post('/api/v1/delegations')
      .set(...authHeader(tl.token))
      .send({
        delegatorId: tl.userId,
        delegateId: delegate.userId,
        validFrom: new Date(Date.now() - 3600_000).toISOString(),
        validTo: new Date(Date.now() + 3600_000).toISOString(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/v1/delegations/${created.body.id}`)
      .set(...authHeader(stranger.token))
      .expect(403);
  });

  it('DELETE on an unknown id 404s', async () => {
    const admin = await realUser('admin3', ['ADMIN']);
    await request(app.getHttpServer())
      .delete('/api/v1/delegations/00000000-0000-7000-8000-000000000000')
      .set(...authHeader(admin.token))
      .expect(404);
  });
});
