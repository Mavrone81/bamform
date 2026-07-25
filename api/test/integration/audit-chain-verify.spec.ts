import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChainVerificationService } from '../../src/audit/chain-verification.service';
import { AuditChainDailyVerificationService } from '../../src/audit/audit-chain-daily-verification.service';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * I-INV-12 (TEST_PLAN.md §9, PR-097): "Tamper with a hash, run chain
 * verification — break detected at the right sequence." Exercises the REAL
 * `ChainVerificationService` (via the app's DI container, not a mock)
 * against real Postgres, so the SQL-formula-vs-trigger-formula correctness
 * point (slice-8-brief.md's "single most important correctness point of the
 * slice") is proven end to end: rows are written by the real slice-1
 * trigger, and `verify()` must recompute matching hashes for every
 * untouched row (no false positives) while still catching the tamper.
 *
 * Tampers are done via `adminPool` (the Postgres owner role) — `bamform_app`
 * cannot `UPDATE`/`DELETE` `audit_event` (I-INV-08/10, `grants.spec.ts`) —
 * mirroring `records-integrity.spec.ts`'s S-10 pattern (PR-TST-08).
 */
describe('ChainVerificationService (I-INV-12)', () => {
  let app: INestApplication;
  let service: ChainVerificationService;
  let dailyJob: AuditChainDailyVerificationService;

  beforeAll(async () => {
    app = await createTestApp();
    service = app.get(ChainVerificationService);
    dailyJob = app.get(AuditChainDailyVerificationService);
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

  it('reports intact for an empty chain', async () => {
    const result = await service.verify();
    expect(result).toMatchObject({ intact: true, eventCount: 0, firstBreakSequence: null });
  });

  it('reports intact and counts every row for a clean, untouched chain (no false positives)', async () => {
    const label = `chain-clean-${randomUUID()}`;
    for (let i = 0; i < 6; i += 1) {
      await insertAuditEvent(label);
    }

    const result = await service.verify();
    expect(result.intact).toBe(true);
    expect(result.firstBreakSequence).toBeNull();
    expect(result.eventCount).toBe(6);
  });

  it('detects a mutated hash (direct UPDATE) at the exact sequence tampered', async () => {
    const label = `chain-mutate-${randomUUID()}`;
    await insertAuditEvent(label);
    const target = await insertAuditEvent(label);
    await insertAuditEvent(label);

    await adminPool.query(
      `UPDATE "audit_event" SET "hash" = digest('tampered', 'sha256') WHERE "sequence" = $1`,
      [target.toString()],
    );

    const result = await service.verify();
    expect(result.intact).toBe(false);
    expect(result.firstBreakSequence).toBe(target);
  });

  it('detects a broken prev_hash link at the exact sequence tampered', async () => {
    const label = `chain-relink-${randomUUID()}`;
    await insertAuditEvent(label);
    const target = await insertAuditEvent(label);
    await insertAuditEvent(label);

    await adminPool.query(
      `UPDATE "audit_event" SET "prev_hash" = digest('not-the-real-parent', 'sha256') WHERE "sequence" = $1`,
      [target.toString()],
    );

    const result = await service.verify();
    expect(result.intact).toBe(false);
    expect(result.firstBreakSequence).toBe(target);
  });

  it('detects a deleted intermediate row as a break at the next surviving sequence', async () => {
    const label = `chain-delete-${randomUUID()}`;
    await insertAuditEvent(label);
    const deleted = await insertAuditEvent(label);
    const after = await insertAuditEvent(label);

    // bamform_app cannot DELETE audit_event (I-INV-10) — this simulates an
    // attacker (or a bug) with elevated/owner DB access, per PR-TST-08.
    await adminPool.query(`DELETE FROM "audit_event" WHERE "sequence" = $1`, [deleted.toString()]);

    const result = await service.verify();
    expect(result.intact).toBe(false);
    expect(result.firstBreakSequence).toBe(after);
  });

  it('paginates correctly across a page boundary smaller than the table (memory-bounded walk)', async () => {
    const label = `chain-paginate-${randomUUID()}`;
    const sequences: bigint[] = [];
    for (let i = 0; i < 12; i += 1) {
      sequences.push(await insertAuditEvent(label));
    }

    const cleanResult = await service.verify(5); // small page size forces multiple pages
    expect(cleanResult.intact).toBe(true);
    expect(cleanResult.eventCount).toBe(12);

    // Tamper a row that lands on the second page with a page size of 5.
    const target = sequences[6];
    await adminPool.query(
      `UPDATE "audit_event" SET "hash" = digest('tampered-page-2', 'sha256') WHERE "sequence" = $1`,
      [target.toString()],
    );

    const brokenResult = await service.verify(5);
    expect(brokenResult.intact).toBe(false);
    expect(brokenResult.firstBreakSequence).toBe(target);
  });

  describe('AuditChainDailyVerificationService (PR-099 daily job)', () => {
    it('is idempotent — records only one chain_break_detected event for the same unresolved break', async () => {
      const label = `chain-daily-${randomUUID()}`;
      await insertAuditEvent(label);
      const target = await insertAuditEvent(label);
      await adminPool.query(
        `UPDATE "audit_event" SET "hash" = digest('tampered', 'sha256') WHERE "sequence" = $1`,
        [target.toString()],
      );

      const firstRun = await dailyJob.run();
      expect(firstRun.intact).toBe(false);

      const countAfterFirst = await adminPool.query(
        `SELECT count(*) FROM "audit_event" WHERE "action" = 'chain_break_detected'`,
      );
      expect(Number(countAfterFirst.rows[0].count)).toBe(1);

      const secondRun = await dailyJob.run();
      expect(secondRun.intact).toBe(false);

      const countAfterSecond = await adminPool.query(
        `SELECT count(*) FROM "audit_event" WHERE "action" = 'chain_break_detected'`,
      );
      expect(Number(countAfterSecond.rows[0].count)).toBe(1);
    });

    it('does not write chain_break_detected when the chain is intact', async () => {
      const label = `chain-daily-ok-${randomUUID()}`;
      await insertAuditEvent(label);
      await insertAuditEvent(label);

      const result = await dailyJob.run();
      expect(result.intact).toBe(true);

      const count = await adminPool.query(
        `SELECT count(*) FROM "audit_event" WHERE "action" = 'chain_break_detected'`,
      );
      expect(Number(count.rows[0].count)).toBe(0);
    });
  });
});
