import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createUser, grantRole } from './helpers/fixtures';
import { closeRedis, resetRedis } from './helpers/redis';
import { authHeader, mintAccessToken } from './helpers/test-auth';

/**
 * S-11 (TEST_PLAN.md §9, threat T-2): "Alter an audit_event hash, run chain
 * verification — break detected at the right sequence." Exercises the real
 * `GET /audit-events/chain-status` endpoint end to end (HTTP), unlike
 * `audit-chain-verify.spec.ts`'s I-INV-12, which calls
 * `ChainVerificationService` directly. Also proves the AUDITOR/ADMIN-only
 * `@Roles()` gate (SECURITY_ARCHITECTURE.md §4.2 P2) and the read-only
 * shape of the endpoint (a `GET` — no write path exists to check "AUDITOR
 * cannot write" against here, unlike S-24's approval endpoints).
 *
 * Previously tracked as a `test.todo` in `test/security/pending-cases.spec.ts`
 * ("no post-hoc chain-verification routine/endpoint exists yet") — it does
 * now.
 */
describe('GET /audit-events/chain-status (S-11, PR-097/PR-099)', () => {
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

  async function insertAuditEvent(entityType: string): Promise<bigint> {
    const result = await adminPool.query(
      `INSERT INTO "audit_event" ("occurred_at", "action", "entity_type")
       VALUES (now(), 'create', $1)
       RETURNING sequence`,
      [entityType],
    );
    return BigInt(result.rows[0].sequence as string);
  }

  it('AUDITOR gets 200 with intact:true for a clean chain', async () => {
    const label = `chain-status-clean-${randomUUID()}`;
    await insertAuditEvent(label);
    await insertAuditEvent(label);

    const userId = await createUser('auditor-status');
    await grantRole(userId, 'AUDITOR');
    const token = await mintAccessToken(app, userId, ['AUDITOR']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-events/chain-status')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body).toMatchObject({ intact: true, firstBreakSequence: null });
    expect(typeof res.body.checkedAt).toBe('string');
    expect(typeof res.body.eventCount).toBe('number');
  });

  it('ADMIN gets 200 too', async () => {
    const userId = await createUser('admin-status');
    await grantRole(userId, 'ADMIN');
    const token = await mintAccessToken(app, userId, ['ADMIN']);

    await request(app.getHttpServer())
      .get('/api/v1/audit-events/chain-status')
      .set(...authHeader(token))
      .expect(200);
  });

  it('a role that is neither AUDITOR nor ADMIN is rejected with 403', async () => {
    const userId = await createUser('maintainer-status');
    await grantRole(userId, 'MAINTAINER');
    const token = await mintAccessToken(app, userId, ['MAINTAINER']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-events/chain-status')
      .set(...authHeader(token))
      .expect(403);
    expect(res.body).toMatchObject({ type: '/errors/forbidden' });
  });

  it('S-11: an audit_event hash altered directly in the database is detected as a break at the right sequence', async () => {
    const label = `chain-status-tamper-${randomUUID()}`;
    await insertAuditEvent(label);
    const target = await insertAuditEvent(label);
    await insertAuditEvent(label);

    // Simulate an attacker (or a bug) editing the stored hash directly,
    // bypassing the application entirely — bamform_app itself cannot
    // UPDATE audit_event (I-INV-08/grants.spec.ts); PR-TST-08 performs this
    // via an elevated/owner DB connection.
    await adminPool.query(
      `UPDATE "audit_event" SET "hash" = digest('tampered', 'sha256') WHERE "sequence" = $1`,
      [target.toString()],
    );

    const userId = await createUser('auditor-tamper');
    await grantRole(userId, 'AUDITOR');
    const token = await mintAccessToken(app, userId, ['AUDITOR']);

    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-events/chain-status')
      .set(...authHeader(token))
      .expect(200);

    expect(res.body.intact).toBe(false);
    expect(res.body.firstBreakSequence).toBe(Number(target));
  });
});
