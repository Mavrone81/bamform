import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import {
  createTestDB,
  getDB,
  recoverStuckSendingRows,
  claimLegacyRows,
  LEGACY_USER_ID,
  type OutboxEntry,
} from './db';
import { append, drain } from './outbox';
import { MockSyncTransport } from '../api/mock-transport';

/** Opens a database with the EXACT v1 schema this app shipped before slice
 * 16 — no `userId` anywhere, `jobs` keyed by bare job id — so the migration
 * tests below run against what a real live device mid-upgrade actually
 * holds, not against a convenient approximation. */
async function seedV1Database(name: string): Promise<void> {
  const v1 = new Dexie(name);
  v1.version(1).stores({
    outbox: 'id, sequence, jobId, status, [jobId+status]',
    jobs: 'id, submitState',
    meta: 'key',
  });
  await v1.table('outbox').bulkAdd([
    {
      id: 'legacy-mutation-1',
      sequence: 1,
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/item-1',
      body: { status: 'DONE' },
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      lastResult: null,
    },
    {
      id: 'legacy-mutation-2',
      sequence: 2,
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/item-2',
      body: { status: 'NOT_DONE' },
      ifMatch: 2,
      clientRecordedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'conflict',
      attempts: 1,
      lastError: null,
      lastResult: { status: 409, problem: null },
    },
  ]);
  await v1.table('jobs').add({
    id: 'job-1',
    job: { id: 'job-1', jobNumber: 'PM-1' },
    cachedAt: new Date().toISOString(),
    hasPendingOutbox: true,
    submitState: 'none',
    serverRemoved: false,
    predictedDraftVersion: 3,
  });
  await v1.table('meta').bulkAdd([
    { key: 'outboxSequenceCounter', value: 2 },
    { key: 'syncToken', value: 'tok-old' },
  ]);
  v1.close();
}

function stuckSendingRow(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: '018e0000-0000-7000-8000-000000000001',
    userId: 'user-1',
    sequence: 1,
    jobId: 'job-1',
    method: 'PUT',
    path: '/jobs/job-1/items/item-1',
    body: { status: 'DONE' },
    ifMatch: 1,
    clientRecordedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    status: 'sending',
    attempts: 1,
    lastError: null,
    lastResult: null,
    ...overrides,
  };
}

describe('BamFormDB', () => {
  it('createTestDB gives each test its own isolated database', async () => {
    const a = createTestDB('db-test-a');
    const b = createTestDB('db-test-b');
    await a.jobs.put({
      userId: 'user-1',
      id: '1',
      job: {} as never,
      cachedAt: '',
      hasPendingOutbox: false,
      submitState: 'none',
      serverRemoved: false,
      predictedDraftVersion: 1,
    });
    expect(await b.jobs.count()).toBe(0);
    await a.delete();
    await b.delete();
  });

  it('getDB returns the same singleton instance on repeated calls', () => {
    const first = getDB();
    const second = getDB();
    expect(second).toBe(first);
  });

  it('exposes the outbox, jobs and meta tables', () => {
    const db = createTestDB('db-test-tables');
    expect(db.outbox).toBeDefined();
    expect(db.jobs).toBeDefined();
    expect(db.meta).toBeDefined();
  });

  describe('recoverStuckSendingRows — closes the mid-send tab-kill hole', () => {
    it('resets a sending row back to pending', async () => {
      const db = createTestDB(`db-test-recover-${Math.random()}`);
      await db.outbox.add(stuckSendingRow());
      await recoverStuckSendingRows(db);
      const row = await db.outbox.get('018e0000-0000-7000-8000-000000000001');
      expect(row?.status).toBe('pending');
      await db.delete();
    });

    it('leaves pending/conflict/failed rows untouched, and is a no-op with nothing stuck', async () => {
      const db = createTestDB(`db-test-recover-noop-${Math.random()}`);
      await db.outbox.bulkAdd([
        stuckSendingRow({ id: 'a', status: 'pending' }),
        stuckSendingRow({ id: 'b', status: 'conflict' }),
        stuckSendingRow({ id: 'c', status: 'failed' }),
      ]);
      await expect(recoverStuckSendingRows(db)).resolves.toBeUndefined();
      expect((await db.outbox.get('a'))?.status).toBe('pending');
      expect((await db.outbox.get('b'))?.status).toBe('conflict');
      expect((await db.outbox.get('c'))?.status).toBe('failed');
      await db.delete();
    });

    it("runs automatically on open — a fresh BamFormDB instance against a PREVIOUS session's storage recovers a row stuck mid-send, and it drains exactly once (idempotency key unchanged, dedupes safely per O-05)", async () => {
      const name = `db-test-tab-kill-${Math.random()}`;

      // Session 1: claim commits ('sending'), then the "tab dies" — no
      // network-error catch ever runs, unlike O-03's scenario.
      const session1 = createTestDB(name);
      const appended = (await append(session1, {
        userId: 'user-1',
        jobId: 'job-1',
        method: 'PUT',
        path: '/jobs/job-1/items/item-1',
        body: { status: 'DONE' },
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
      })) as { ok: true; entry: { id: string } };
      const claimed = await session1.outbox.get(appended.entry.id);
      await session1.outbox.put({ ...claimed!, status: 'sending' });
      session1.close(); // simulates the tab/process ending mid-network-call

      // Session 2: a brand new BamFormDB instance opening the SAME
      // underlying storage — exactly what a reopened tab / app restart is.
      const session2 = createTestDB(name);
      await session2.open();
      const recovered = await session2.outbox.get(appended.entry.id);
      expect(recovered?.status).toBe('pending'); // reachable by listDrainable again

      const transport = new MockSyncTransport();
      const summary = await drain(session2, transport, 'user-1');
      expect(summary.acked).toBe(1);
      expect(await session2.outbox.get(appended.entry.id)).toBeUndefined();
      expect(transport.timesApplied(appended.entry.id)).toBe(1); // exactly once, not a double-apply

      await session2.delete();
    });

    it('does not resurrect a row whose previous session already saw it acknowledged and deleted', async () => {
      // If the row was legitimately cleared (applied: true) before the tab
      // died, there is nothing left in the outbox for recovery to touch —
      // confirms recovery only ever acts on rows that are actually still
      // present, never reconstructs a deleted one.
      const name = `db-test-recover-already-cleared-${Math.random()}`;
      const session1 = createTestDB(name);
      const appended = (await append(session1, {
        userId: 'user-1',
        jobId: 'job-1',
        method: 'PUT',
        path: '/jobs/job-1/items/item-1',
        body: { status: 'DONE' },
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
      })) as { ok: true; entry: { id: string } };
      const transport = new MockSyncTransport();
      await drain(session1, transport, 'user-1'); // fully acked and cleared before "the tab dies"
      session1.close();

      const session2 = createTestDB(name);
      await session2.open();
      expect(await session2.outbox.get(appended.entry.id)).toBeUndefined();
      expect(await session2.outbox.count()).toBe(0);
      await session2.delete();
    });
  });

  describe('O-18: v1 → v2 migration — a live device mid-upgrade loses NOTHING', () => {
    it('preserves every unsent outbox row (all statuses) and the cached job through the upgrade', async () => {
      const name = `db-test-migration-${Math.random()}`;
      await seedV1Database(name);

      const db = createTestDB(name);
      await db.open();

      // Every unsent mutation survives, stamped as legacy-owned until a
      // server-confirmed principal claims it.
      const row1 = await db.outbox.get('legacy-mutation-1');
      const row2 = await db.outbox.get('legacy-mutation-2');
      expect(row1?.status).toBe('pending');
      expect(row1?.userId).toBe(LEGACY_USER_ID);
      expect(row2?.status).toBe('conflict');
      expect(row2?.userId).toBe(LEGACY_USER_ID);
      expect(row2?.lastResult?.status).toBe(409);

      // The cached job (with its local edit state) survives under the
      // legacy owner in the new per-user store.
      const job = await db.jobs.get([LEGACY_USER_ID, 'job-1']);
      expect(job?.hasPendingOutbox).toBe(true);
      expect(job?.predictedDraftVersion).toBe(3);

      // Device-level meta is untouched.
      expect((await db.meta.get('outboxSequenceCounter'))?.value).toBe(2);
      await db.delete();
    });

    it('claimLegacyRows re-keys legacy outbox rows and cached jobs to the server-confirmed user', async () => {
      const name = `db-test-claim-${Math.random()}`;
      await seedV1Database(name);
      const db = createTestDB(name);
      await db.open();

      await claimLegacyRows(db, 'user-1');

      expect((await db.outbox.get('legacy-mutation-1'))?.userId).toBe('user-1');
      expect((await db.outbox.get('legacy-mutation-2'))?.userId).toBe('user-1');
      expect(await db.jobs.get(['user-1', 'job-1'])).toBeDefined();
      expect(await db.jobs.get([LEGACY_USER_ID, 'job-1'])).toBeUndefined();

      // Idempotent, and never steals rows already owned by someone else.
      await claimLegacyRows(db, 'user-2');
      expect((await db.outbox.get('legacy-mutation-1'))?.userId).toBe('user-1');
      expect(await db.jobs.get(['user-1', 'job-1'])).toBeDefined();
      expect(await db.jobs.get(['user-2', 'job-1'])).toBeUndefined();
      await db.delete();
    });

    it('two users can hold a cached copy of the SAME job id simultaneously (compound primary key)', async () => {
      const db = createTestDB(`db-test-compound-${Math.random()}`);
      const base = {
        id: 'job-9',
        job: {} as never,
        cachedAt: new Date().toISOString(),
        hasPendingOutbox: false,
        submitState: 'none' as const,
        serverRemoved: false,
        predictedDraftVersion: 1,
      };
      await db.jobs.put({ ...base, userId: 'user-a', predictedDraftVersion: 5 });
      await db.jobs.put({ ...base, userId: 'user-b', predictedDraftVersion: 9 });
      expect((await db.jobs.get(['user-a', 'job-9']))?.predictedDraftVersion).toBe(5);
      expect((await db.jobs.get(['user-b', 'job-9']))?.predictedDraftVersion).toBe(9);
      await db.delete();
    });
  });
});
