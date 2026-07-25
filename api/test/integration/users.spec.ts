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
