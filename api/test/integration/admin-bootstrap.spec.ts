import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { UsersService } from '../../src/users/users.service';
import { PasswordService } from '../../src/auth/password/password.service';

describe('First-ADMIN bootstrap — UsersService.bootstrapFirstAdmin', () => {
  let app: INestApplication;
  let users: UsersService;
  let passwords: PasswordService;

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get(UsersService);
    passwords = app.get(PasswordService);
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

  const input = () => ({
    fullName: 'Boot Strap',
    email: `admin-${randomUUID()}@example.com`,
    password: 'correct horse battery',
  });

  it('creates the first admin on an empty system, with the ADMIN role', async () => {
    const dto = input();
    const created = await users.bootstrapFirstAdmin(dto);
    expect(created.email).toBe(dto.email);
    expect(created.roles).toContain('ADMIN');
  });

  it('creates an account whose password actually verifies (can log in)', async () => {
    const dto = input();
    const created = await users.bootstrapFirstAdmin(dto);
    const { rows } = await adminPool.query(
      `SELECT "password_hash" FROM "app_user" WHERE "id" = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(await passwords.verify(rows[0].password_hash, dto.password)).toBe(true);
  });

  it("self-grants the ADMIN role (granted_by = the new admin's own id)", async () => {
    const created = await users.bootstrapFirstAdmin(input());
    const { rows } = await adminPool.query(
      `SELECT ur."granted_by", r."code"
         FROM "user_role" ur JOIN "role" r ON r."id" = ur."role_id"
        WHERE ur."user_id" = $1 AND ur."active" = true`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('ADMIN');
    expect(rows[0].granted_by).toBe(created.id);
  });

  it('does NOT force a password change (operator chose their own password)', async () => {
    const created = await users.bootstrapFirstAdmin(input());
    const { rows } = await adminPool.query(
      `SELECT "must_change_password" FROM "app_user" WHERE "id" = $1`,
      [created.id],
    );
    expect(rows[0].must_change_password).toBe(false);
  });

  it('records a create audit event for the new admin', async () => {
    const created = await users.bootstrapFirstAdmin(input());
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM "audit_event"
        WHERE "entity_type" = 'user' AND "entity_id" = $1 AND "action" = 'create'`,
      [created.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('records the audit event WITHOUT decrypted PII (ciphertext digests only, per toUserAuditView)', async () => {
    const dto = {
      fullName: 'Zzyzx Quorvantha Boötstrap',
      email: `zzyzx-quorvantha-${randomUUID()}@example.com`,
      password: 'correct horse battery',
    };
    const created = await users.bootstrapFirstAdmin(dto);
    const { rows } = await adminPool.query(
      `SELECT "after" FROM "audit_event"
        WHERE "entity_type" = 'user' AND "entity_id" = $1 AND "action" = 'create'`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0].after);
    // CR-5/PR-SEC-02: `after` must be `toUserAuditView`'s projection — ciphertext
    // digests, never the decrypted `toUser` view — because audit_event is
    // append-only with 7-year retention and no deletion path. A future edit
    // that swapped in the decrypted view would leak these plaintexts here
    // permanently; this asserts that never happens.
    expect(serialized).not.toContain(dto.fullName);
    expect(serialized).not.toContain(dto.email);
    expect(rows[0].after).toHaveProperty('fullNameCtSha256');
    expect(rows[0].after).toHaveProperty('emailCtSha256');
    expect(typeof rows[0].after.fullNameCtSha256).toBe('string');
    expect(typeof rows[0].after.emailCtSha256).toBe('string');
  });

  it('refuses when any user already exists, and writes nothing', async () => {
    await users.bootstrapFirstAdmin(input());
    const { rows: before } = await adminPool.query(`SELECT count(*)::int AS n FROM "app_user"`);
    await expect(users.bootstrapFirstAdmin(input())).rejects.toThrow(/Bootstrap refused/);
    const { rows: after } = await adminPool.query(`SELECT count(*)::int AS n FROM "app_user"`);
    expect(after[0].n).toBe(before[0].n);
  });
});
