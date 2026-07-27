import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { decodeIdentityField } from '../../src/auth/crypto/identity-codec';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createLoginableUser, loadFieldEncryptionService } from './helpers/auth-fixtures';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * Slice 13a — UR-072/073/074, PR-037. `POST/GET/PATCH /users`, `GET /roles`.
 */
describe('Users/roles administration — /users, /roles', () => {
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

  // `GET /users` decrypts EVERY `app_user` row it lists, including the
  // caller's own — so the actor calling these endpoints must be a REAL,
  // properly-encrypted row (`createLoginableUser`, the same real crypto path
  // `field-encryption.spec.ts` uses), not the plain `fixtures.ts#createUser`
  // placeholder-bytes helper other suites use purely for FK/ownership rows
  // they never decrypt. Roles are still minted straight into the JWT
  // (`mintAccessToken`), independent of `user_role`.
  async function adminToken(): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `admin-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Admin Actor',
      roleCodes: ['ADMIN'],
    });
    return mintAccessToken(app, userId, ['ADMIN']);
  }

  async function engineerToken(): Promise<string> {
    const { userId } = await createLoginableUser({
      email: `engineer-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Engineer Actor',
      roleCodes: ['ENGINEER'],
    });
    return mintAccessToken(app, userId, ['ENGINEER']);
  }

  interface UserPayload {
    fullName: string;
    email: string;
    password: string;
    roleCodes: string[];
    employeeId?: string;
  }

  function newUserPayload(overrides: Partial<UserPayload> = {}): UserPayload {
    const unique = randomUUID();
    return {
      fullName: 'Test Person',
      email: `person-${unique}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
      ...overrides,
    };
  }

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/users').expect(401);
  });

  it('a non-ADMIN is forbidden from every /users route (UR-074 server-enforced)', async () => {
    const token = await engineerToken();
    const payload = newUserPayload();

    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set(...authHeader(token))
      .expect(403);

    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(payload)
      .expect(403);
    expect(created.body.type).toBe('/errors/forbidden');

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${randomUUID()}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(403);
  });

  it('ADMIN creates a user: encrypted personal data, role assigned, no password leak, audited', async () => {
    const token = await adminToken();
    const payload = newUserPayload({ employeeId: `EMP-${randomUUID()}` });

    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(payload)
      .expect(201);

    expect(res.body).toMatchObject({
      fullName: payload.fullName,
      email: payload.email,
      employeeId: payload.employeeId,
      status: 'ACTIVE',
      active: true,
      roles: ['ENGINEER'],
    });
    expect(res.body.password).toBeUndefined();
    expect(res.body.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(payload.password);

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'user' AND entity_id = $1`,
      [res.body.id],
    );
    expect(audit.rows[0]?.action).toBe('create');
  });

  it("RV-2/S-10-evidence: the created user's name/email are ciphertext in the DB, readable through the API", async () => {
    const token = await adminToken();
    const payload = newUserPayload();

    const res = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(payload)
      .expect(201);

    const row = await adminPool.query(
      `SELECT "full_name_ct", "email_ct", "dek_version", "password_hash" FROM "app_user" WHERE "id" = $1`,
      [res.body.id],
    );
    expect(row.rows[0].full_name_ct.toString('utf8')).not.toContain(payload.fullName);
    expect(row.rows[0].email_ct.toString('utf8')).not.toContain(payload.email);
    // Password stored ONLY as an Argon2id hash, never in cleartext or echoed anywhere.
    expect(row.rows[0].password_hash).not.toBe(payload.password);
    expect(String(row.rows[0].password_hash)).toMatch(/^\$argon2id\$/);

    const fieldEncryption = loadFieldEncryptionService();
    const decodedName = decodeIdentityField(
      row.rows[0].full_name_ct,
      row.rows[0].dek_version,
      { column: 'full_name_ct', rowId: res.body.id },
      fieldEncryption,
    );
    const decodedEmail = decodeIdentityField(
      row.rows[0].email_ct,
      row.rows[0].dek_version,
      { column: 'email_ct', rowId: res.body.id },
      fieldEncryption,
    );
    expect(decodedName).toBe(payload.fullName);
    expect(decodedEmail).toBe(payload.email);
  });

  it('rejects a duplicate email with 409 (blind-index uniqueness)', async () => {
    const token = await adminToken();
    const payload = newUserPayload();

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(payload)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload({ email: payload.email }))
      .expect(409);
  });

  it('rejects an unknown roleCode with 422', async () => {
    const token = await adminToken();

    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload({ roleCodes: ['NOT_A_REAL_ROLE'] }))
      .expect(422);
  });

  it('GET /users lists, paginated', async () => {
    const token = await adminToken();
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload())
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/users?limit=5')
      .set(...authHeader(token))
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.page).toMatchObject({ limit: 5 });
  });

  it('GET /users/{userId} fetches one', async () => {
    const token = await adminToken();
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload())
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${created.body.id}`)
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.id).toBe(created.body.id);
  });

  it('PATCH edits fullName/email and re-encrypts (audited as update)', async () => {
    const token = await adminToken();
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload())
      .expect(201);

    const newEmail = `changed-${randomUUID()}@bevorasg.com`;
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${created.body.id}`)
      .set(...authHeader(token))
      .send({ fullName: 'Changed Name', email: newEmail })
      .expect(200);

    expect(res.body).toMatchObject({ fullName: 'Changed Name', email: newEmail });

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'user' AND entity_id = $1 ORDER BY sequence`,
      [created.body.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['create', 'update']);
  });

  it('PATCH deactivates via the `active` flag — NO hard delete, row survives (PR-039/UR-075)', async () => {
    const token = await adminToken();
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload())
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${created.body.id}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(200);

    expect(res.body).toMatchObject({ active: false, status: 'DEACTIVATED' });

    const row = await adminPool.query(`SELECT "deactivated_at" FROM "app_user" WHERE "id" = $1`, [
      created.body.id,
    ]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].deactivated_at).not.toBeNull();

    // Reactivation is symmetric — still no delete, just the flag flipping back.
    const reactivated = await request(app.getHttpServer())
      .patch(`/api/v1/users/${created.body.id}`)
      .set(...authHeader(token))
      .send({ active: true })
      .expect(200);
    expect(reactivated.body).toMatchObject({ active: true, status: 'ACTIVE' });
  });

  it('PATCH roleCodes replaces the role set, soft-revoking the dropped role (no DELETE, INV-16) and audits permission_change', async () => {
    const token = await adminToken();
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send(newUserPayload({ roleCodes: ['ENGINEER'] }))
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${created.body.id}`)
      .set(...authHeader(token))
      .send({ roleCodes: ['MAINTAINER'] })
      .expect(200);

    expect(res.body.roles).toEqual(['MAINTAINER']);

    const rows = await adminPool.query(
      `SELECT r.code, ur.active FROM "user_role" ur JOIN "role" r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
      [created.body.id],
    );
    // The ENGINEER row is NOT deleted — soft-revoked (active=false).
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { code: 'ENGINEER', active: false },
        { code: 'MAINTAINER', active: true },
      ]),
    );

    const audit = await adminPool.query(
      `SELECT action FROM "audit_event" WHERE entity_type = 'user' AND entity_id = $1 ORDER BY sequence`,
      [created.body.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['create', 'permission_change']);

    // Re-granting ENGINEER reactivates the SAME row rather than inserting a second one.
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${created.body.id}`)
      .set(...authHeader(token))
      .send({ roleCodes: ['ENGINEER', 'MAINTAINER'] })
      .expect(200);

    const rowsAfterRegrant = await adminPool.query(
      `SELECT r.code, ur.active FROM "user_role" ur JOIN "role" r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
      [created.body.id],
    );
    expect(rowsAfterRegrant.rows).toEqual([
      { code: 'ENGINEER', active: true },
      { code: 'MAINTAINER', active: true },
    ]);
    expect(rowsAfterRegrant.rowCount).toBe(2); // still exactly 2 rows, never a duplicate insert.
  });

  // ------------------------------------------------------------- SYS-11
  // (system-review-2026-07-27): prod runs with exactly ONE admin — one
  // mistaken PATCH (or one 13-UI-B toggle) used to lock all admin access out
  // of production, with psql surgery the only recovery.

  it('SYS-11: the LAST active ADMIN cannot deactivate their own account — 409, account untouched', async () => {
    const { userId } = await createLoginableUser({
      email: `sole-admin-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Sole Admin',
      roleCodes: ['ADMIN'],
    });
    const token = await mintAccessToken(app, userId, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${userId}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(409);
    expect(res.body.detail).toMatch(/last active ADMIN/i);

    const row = await adminPool.query(`SELECT status FROM "app_user" WHERE id = $1`, [userId]);
    expect(row.rows[0].status).toBe('active');
  });

  it('SYS-11: the LAST active ADMIN cannot drop their own ADMIN role — 409, roles untouched', async () => {
    const { userId } = await createLoginableUser({
      email: `sole-admin-role-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Sole Admin Role',
      roleCodes: ['ADMIN'],
    });
    const token = await mintAccessToken(app, userId, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${userId}`)
      .set(...authHeader(token))
      .send({ roleCodes: ['ENGINEER'] })
      .expect(409);
    expect(res.body.detail).toMatch(/last active ADMIN/i);

    const roles = await adminPool.query(
      `SELECT r.code FROM "user_role" ur JOIN "role" r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.active`,
      [userId],
    );
    expect(roles.rows.map((r) => r.code)).toEqual(['ADMIN']);
  });

  it('SYS-11: with a SECOND active ADMIN present, self-deactivation is permitted (the guard is last-admin, not self)', async () => {
    const { userId: firstAdmin } = await createLoginableUser({
      email: `admin-a-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Admin A',
      roleCodes: ['ADMIN'],
    });
    await createLoginableUser({
      email: `admin-b-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Admin B',
      roleCodes: ['ADMIN'],
    });
    const token = await mintAccessToken(app, firstAdmin, ['ADMIN']);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/users/${firstAdmin}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(200);
    expect(res.body).toMatchObject({ active: false, status: 'DEACTIVATED' });
  });

  it('SYS-11: a deactivated or admin-role-stripped OTHER admin does not count as cover — the last WORKING admin is protected', async () => {
    const { userId: soleAdmin } = await createLoginableUser({
      email: `admin-real-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Real Admin',
      roleCodes: ['ADMIN'],
    });
    // A second "admin" who is deactivated, and a third whose ADMIN role was revoked.
    const { userId: deadAdmin } = await createLoginableUser({
      email: `admin-dead-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Deactivated Admin',
      roleCodes: ['ADMIN'],
    });
    await adminPool.query(`UPDATE "app_user" SET status = 'deactivated' WHERE id = $1`, [
      deadAdmin,
    ]);
    const { userId: exAdmin } = await createLoginableUser({
      email: `admin-ex-${randomUUID()}@bevorasg.com`,
      password: 'CorrectHorseBattery1!',
      fullName: 'Ex Admin',
      roleCodes: ['ADMIN', 'ENGINEER'],
    });
    await adminPool.query(
      `UPDATE "user_role" SET active = false
       WHERE user_id = $1 AND role_id = (SELECT id FROM "role" WHERE code = 'ADMIN')`,
      [exAdmin],
    );

    const token = await mintAccessToken(app, soleAdmin, ['ADMIN']);
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${soleAdmin}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(409);
  });

  // ------------------------------------------------------------- CR-5
  // (crypto-review-2026-07-27, Critical): `audit_event` is append-only with
  // 7-year retention and NO deletion path — decrypted names/emails written
  // into `before`/`after` are a PERMANENT PR-SEC-02 violation that defeats
  // the field encryption for every user administered through the API.
  // PR-SEC-02: "records that the field changed and its ciphertext digest,
  // not the value."

  it('CR-5: NO decrypted name/email/employeeId ever appears in a user audit payload — create AND update paths; ciphertext digests are recorded instead', async () => {
    const token = await adminToken();
    const fullName = `Leak Canary ${randomUUID()}`;
    const email = `leak-canary-${randomUUID()}@bevorasg.com`;
    const employeeId = `EMP-LEAK-${randomUUID()}`;

    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(...authHeader(token))
      .send({
        fullName,
        email,
        employeeId,
        password: 'CorrectHorseBattery1!',
        roleCodes: ['ENGINEER'],
      })
      .expect(201);
    const userId = created.body.id as string;

    const newName = `Renamed Canary ${randomUUID()}`;
    const newEmail = `renamed-canary-${randomUUID()}@bevorasg.com`;
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${userId}`)
      .set(...authHeader(token))
      .send({ fullName: newName, email: newEmail })
      .expect(200);
    // Also exercise the deactivation-path audit write.
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${userId}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(200);

    const rows = await adminPool.query(
      `SELECT action, before, after FROM "audit_event" WHERE entity_type = 'user' AND entity_id = $1 ORDER BY sequence`,
      [userId],
    );
    expect(rows.rowCount).toBeGreaterThanOrEqual(3); // create + 2 updates
    const allPayloads = JSON.stringify(rows.rows);
    for (const plaintext of [fullName, email, employeeId, newName, newEmail]) {
      expect(allPayloads).not.toContain(plaintext);
    }
    // The email's local parts must not leak in any casing either.
    expect(allPayloads.toLowerCase()).not.toContain('leak-canary');
    expect(allPayloads.toLowerCase()).not.toContain('renamed-canary');

    // PR-SEC-02's positive half: the payload still lets an auditor see THAT
    // the encrypted fields changed — ciphertext digests, non-personal fields.
    const createPayload = rows.rows[0].after as Record<string, unknown>;
    expect(createPayload).toMatchObject({ id: userId, status: 'active' });
    expect(typeof createPayload.fullNameCtSha256).toBe('string');
    expect(typeof createPayload.emailCtSha256).toBe('string');
    const updateRow = rows.rows.find((r) => r.action === 'update')!;
    const beforeDigest = (updateRow.before as Record<string, unknown>).emailCtSha256;
    const afterDigest = (updateRow.after as Record<string, unknown>).emailCtSha256;
    expect(typeof beforeDigest).toBe('string');
    expect(typeof afterDigest).toBe('string');
    expect(beforeDigest).not.toEqual(afterDigest); // the change is still evident
  });

  it('returns 404 for a PATCH/GET against an unknown userId', async () => {
    const token = await adminToken();
    await request(app.getHttpServer())
      .get(`/api/v1/users/${randomUUID()}`)
      .set(...authHeader(token))
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${randomUUID()}`)
      .set(...authHeader(token))
      .send({ active: false })
      .expect(404);
  });

  it('GET /roles returns the seeded catalogue to any authenticated user', async () => {
    const token = await engineerToken();
    const res = await request(app.getHttpServer())
      .get('/api/v1/roles')
      .set(...authHeader(token))
      .expect(200);

    const codes = res.body.data.map((role: { code: string }) => role.code).sort();
    expect(codes).toEqual(
      ['ADMIN', 'AUDITOR', 'DOC_CONTROLLER', 'ENGINEER', 'MAINTAINER', 'TEAM_LEADER'].sort(),
    );
  });
});
