import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createLoginableUser } from './helpers/auth-fixtures';
import { createArea, createJobFixture, createUser, grantRole } from './helpers/fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * Slice 13-UI-B — `PUT /users/{userId}/area-scopes` (SYS-10: area scoping was
 * UNREACHABLE — `user_area_scope` was read everywhere and written nowhere, so
 * every user was unrestricted forever). This suite proves the write path
 * exists, is ADMIN-only, soft-removes (INV-16: no DELETE grant), audits in
 * the same transaction, and — the point of the whole apparatus — that a
 * scope set through the API then actually BITES on the read side (the
 * pre-existing PR-API-10 repository-layer enforcement).
 */
describe('User area scopes — PUT /users/{userId}/area-scopes (SYS-10)', () => {
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

  // `PUT /users/{id}/area-scopes` returns the decrypted `User` shape, so the
  // actor AND subject must be real encrypted rows (same reasoning as
  // users.spec.ts#adminToken), not placeholder-bytes fixtures.
  async function adminActor(): Promise<{ userId: string; token: string }> {
    const { userId } = await createLoginableUser({
      email: `admin-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Admin Actor',
      roleCodes: ['ADMIN'],
    });
    return { userId, token: await mintAccessToken(app, userId, ['ADMIN']) };
  }

  async function subjectUser(roleCodes: string[] = ['TEAM_LEADER']): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `subject-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Subject User',
      roleCodes,
    });
    return userId;
  }

  async function scopeRows(userId: string): Promise<Array<{ area_id: string; active: boolean }>> {
    const res = await adminPool.query(
      `SELECT area_id, active FROM "user_area_scope" WHERE user_id = $1 ORDER BY area_id`,
      [userId],
    );
    return res.rows as Array<{ area_id: string; active: boolean }>;
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/users/${randomUUID()}/area-scopes`)
      .send({ areaIds: [] })
      .expect(401);
  });

  it('a non-ADMIN is forbidden (server-enforced, UR-074)', async () => {
    const { userId } = await createLoginableUser({
      email: `eng-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Engineer Actor',
      roleCodes: ['ENGINEER'],
    });
    const token = await mintAccessToken(app, userId, ['ENGINEER']);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/users/${randomUUID()}/area-scopes`)
      .set(...authHeader(token))
      .send({ areaIds: [] })
      .expect(403);
    expect(res.body.type).toBe('/errors/forbidden');
  });

  it('404s an unknown user', async () => {
    const admin = await adminActor();
    await request(app.getHttpServer())
      .put(`/api/v1/users/${randomUUID()}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [] })
      .expect(404);
  });

  it('422s an areaId that does not exist', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const res = await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [randomUUID()] })
      .expect(422);
    expect(res.body.type).toBe('/errors/validation-failed');
  });

  it('422s a malformed body (areaIds not an array of uuids)', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: ['not-a-uuid'] })
      .expect(422);
  });

  it('ADMIN sets scopes; the User response and GET /users/{id} carry areaIds', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`SC-A-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`SC-B-${randomUUID().slice(0, 8)}`);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA, areaB] })
      .expect(200);
    expect([...res.body.areaIds].sort()).toEqual([areaA, areaB].sort());

    const read = await request(app.getHttpServer())
      .get(`/api/v1/users/${subject}`)
      .set(...authHeader(admin.token))
      .expect(200);
    expect([...read.body.areaIds].sort()).toEqual([areaA, areaB].sort());

    const list = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set(...authHeader(admin.token))
      .expect(200);
    const row = list.body.data.find((u: { id: string }) => u.id === subject);
    expect([...row.areaIds].sort()).toEqual([areaA, areaB].sort());
  });

  it('replacing the set SOFT-removes a dropped scope (row kept, active=false — INV-16, no DELETE)', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`SR-A-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`SR-B-${randomUUID().slice(0, 8)}`);

    await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA, areaB] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA] })
      .expect(200);
    expect(res.body.areaIds).toEqual([areaA]);

    // The dropped row still EXISTS (nothing was deleted) but is inactive.
    const rows = await scopeRows(subject);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.area_id === areaA)?.active).toBe(true);
    expect(rows.find((r) => r.area_id === areaB)?.active).toBe(false);
  });

  it('re-granting a previously revoked scope flips the SAME row back (no duplicate)', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`RG-A-${randomUUID().slice(0, 8)}`);

    for (const areaIds of [[areaA], [], [areaA]]) {
      await request(app.getHttpServer())
        .put(`/api/v1/users/${subject}/area-scopes`)
        .set(...authHeader(admin.token))
        .send({ areaIds })
        .expect(200);
    }

    const rows = await scopeRows(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ area_id: areaA, active: true });
  });

  it('PUT [] clears every scope (user returns to unrestricted) without deleting rows', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`CL-A-${randomUUID().slice(0, 8)}`);

    await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [] })
      .expect(200);
    expect(res.body.areaIds).toEqual([]);

    const rows = await scopeRows(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
  });

  it('duplicate areaIds in the request are applied once', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`DU-A-${randomUUID().slice(0, 8)}`);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA, areaA] })
      .expect(200);
    expect(res.body.areaIds).toEqual([areaA]);
    expect(await scopeRows(subject)).toHaveLength(1);
  });

  it('audits `permission_change` in the SAME transaction, with NO personal data in the payload (CR-5)', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`AU-A-${randomUUID().slice(0, 8)}`);

    await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA] })
      .expect(200);

    const audit = await adminPool.query(
      `SELECT action, actor_id, before, after FROM "audit_event"
        WHERE entity_type = 'user' AND entity_id = $1
        ORDER BY occurred_at DESC`,
      [subject],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].action).toBe('permission_change');
    expect(audit.rows[0].actor_id).toBe(admin.userId);
    expect(audit.rows[0].before).toEqual({ areaIds: [] });
    expect(audit.rows[0].after).toEqual({ areaIds: [areaA] });
    // CR-5/PR-SEC-02: the payload must never carry decrypted person-fields.
    const payload = JSON.stringify([audit.rows[0].before, audit.rows[0].after]);
    expect(payload).not.toContain('Subject User');
    expect(payload).not.toContain('@bevorasg.com');
  });

  it('an UNCHANGED set produces no second audit event (idempotent PUT)', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`ID-A-${randomUUID().slice(0, 8)}`);

    for (let i = 0; i < 2; i += 1) {
      await request(app.getHttpServer())
        .put(`/api/v1/users/${subject}/area-scopes`)
        .set(...authHeader(admin.token))
        .send({ areaIds: [areaA] })
        .expect(200);
    }

    const audit = await adminPool.query(
      `SELECT id FROM "audit_event"
        WHERE entity_type = 'user' AND entity_id = $1 AND action = 'permission_change'`,
      [subject],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('/auth/me reports only ACTIVE scopes (a revoked scope disappears from areaScope)', async () => {
    const admin = await adminActor();
    const subject = await subjectUser();
    const areaA = await createArea(`ME-A-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`ME-B-${randomUUID().slice(0, 8)}`);

    await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA, areaB] })
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/v1/users/${subject}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA] })
      .expect(200);

    const subjectToken = await mintAccessToken(app, subject, ['TEAM_LEADER']);
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set(...authHeader(subjectToken))
      .expect(200);
    expect(me.body.areaScope).toEqual([areaA]);
  });

  // ------------------------------------------------------------------
  // The point of the whole endpoint: a scope written through the API then
  // actually restricts what the subject can SEE (PR-API-10 read-side
  // enforcement, which existed all along but was unreachable — SYS-10).
  // ------------------------------------------------------------------

  it("SCOPING BITES: a TL scoped (via the API) to area B stops seeing area A's queue — and re-scoping to A restores it", async () => {
    const admin = await adminActor();
    const areaA = await createArea(`QB-A-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`QB-B-${randomUUID().slice(0, 8)}`);

    // A SUBMITTED job on an asset in area A, awaiting stage-1 verification
    // (same fixture shape as queue.spec.ts#submittedJob).
    const maintainerId = await createUser('maintainer-scope');
    await grantRole(maintainerId, 'MAINTAINER');
    const fixture = await createJobFixture(`PM-SCOPE-${randomUUID()}`, 'submitted', {
      submittedBy: maintainerId,
      submittedAt: new Date(),
      currentStageOrdinal: 1,
    });
    await adminPool.query('UPDATE "asset" SET area_id = $1 WHERE id = $2', [
      areaA,
      fixture.assetId,
    ]);

    const tl = await subjectUser(['TEAM_LEADER']);
    const tlToken = await mintAccessToken(app, tl, ['TEAM_LEADER']);

    // Unrestricted: the TL sees the job.
    const before = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tlToken))
      .expect(200);
    expect(before.body.data.map((e: { id: string }) => e.id)).toContain(fixture.jobId);

    // Scope the TL to area B THROUGH THE API — the queue empties.
    await request(app.getHttpServer())
      .put(`/api/v1/users/${tl}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaB] })
      .expect(200);
    const scoped = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tlToken))
      .expect(200);
    expect(scoped.body.data.map((e: { id: string }) => e.id)).not.toContain(fixture.jobId);

    // Re-scope to area A — visibility returns (the soft-removed B row must
    // not still count against them).
    await request(app.getHttpServer())
      .put(`/api/v1/users/${tl}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA] })
      .expect(200);
    const rescoped = await request(app.getHttpServer())
      .get('/api/v1/queue')
      .set(...authHeader(tlToken))
      .expect(200);
    expect(rescoped.body.data.map((e: { id: string }) => e.id)).toContain(fixture.jobId);
  });

  it("SCOPING BITES on assets too: a scoped user lists only their area's assets", async () => {
    const admin = await adminActor();
    const areaA = await createArea(`AB-A-${randomUUID().slice(0, 8)}`);
    const areaB = await createArea(`AB-B-${randomUUID().slice(0, 8)}`);

    const fixtureA = await createJobFixture(`PM-AS-A-${randomUUID()}`, 'assigned');
    const fixtureB = await createJobFixture(`PM-AS-B-${randomUUID()}`, 'assigned');
    await adminPool.query('UPDATE "asset" SET area_id = $1 WHERE id = $2', [
      areaA,
      fixtureA.assetId,
    ]);
    await adminPool.query('UPDATE "asset" SET area_id = $1 WHERE id = $2', [
      areaB,
      fixtureB.assetId,
    ]);

    const tl = await subjectUser(['TEAM_LEADER']);
    const tlToken = await mintAccessToken(app, tl, ['TEAM_LEADER']);

    await request(app.getHttpServer())
      .put(`/api/v1/users/${tl}/area-scopes`)
      .set(...authHeader(admin.token))
      .send({ areaIds: [areaA] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/assets')
      .set(...authHeader(tlToken))
      .expect(200);
    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(fixtureA.assetId);
    expect(ids).not.toContain(fixtureB.assetId);
  });
});
