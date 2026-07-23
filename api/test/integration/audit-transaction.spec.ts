import { randomUUID } from 'node:crypto';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture } from './helpers/fixtures';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeAll();
});

describe('PR-098 audit writes share the transaction with the change', () => {
  it('I-INV-11 rolls back the change when the audit write fails mid-transaction', async () => {
    const { jobId } = await createJobFixture(`PM-${randomUUID()}`, 'assigned');

    const before = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(before.rows[0].status).toBe('assigned');

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE "job" SET status = 'in_progress' WHERE id = $1`, [jobId]);

      // Force the audit write to fail — action is NOT NULL and has no
      // default, so omitting it is a guaranteed not-null violation. The
      // trigger-computed hash/prev_hash columns cannot be forced to fail
      // (they are always overwritten BEFORE INSERT), so this is the
      // reliable way to make "the audit write fails" happen in a test.
      await expect(
        client.query(
          `INSERT INTO "audit_event" ("occurred_at", "entity_type", "entity_id")
           VALUES (now(), 'job', $1)`,
          [jobId],
        ),
      ).rejects.toMatchObject({ code: '23502' }); // not_null_violation

      // Postgres has now aborted the transaction; COMMIT is a no-op rollback.
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = await adminPool.query('SELECT status FROM "job" WHERE id = $1', [jobId]);
    expect(after.rows[0].status).toBe('assigned');
  });

  it('supplementary: INV-10 hash chain links each row to the previous hash', async () => {
    const first = await adminPool.query(
      `INSERT INTO "audit_event" ("occurred_at", "action", "entity_type")
       VALUES (now(), 'create', 'chain-test-1')
       RETURNING sequence, prev_hash, hash`,
    );
    const second = await adminPool.query(
      `INSERT INTO "audit_event" ("occurred_at", "action", "entity_type")
       VALUES (now(), 'create', 'chain-test-2')
       RETURNING sequence, prev_hash, hash`,
    );

    const firstHash: Buffer = first.rows[0].hash;
    const secondPrevHash: Buffer = second.rows[0].prev_hash;

    expect(firstHash).toBeInstanceOf(Buffer);
    expect(firstHash.length).toBe(32); // SHA-256 digest
    expect(secondPrevHash.equals(firstHash)).toBe(true);
    expect(Number(second.rows[0].sequence)).toBeGreaterThan(Number(first.rows[0].sequence));
  });
});
