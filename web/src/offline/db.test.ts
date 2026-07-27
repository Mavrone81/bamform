import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import {
  createTestDB,
  getDB,
  recoverStuckSendingRows,
  claimLegacyRows,
  legacyHoldSummary,
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

    it('H-4: claims only rows whose job carries a MATCHING server-attested assignedTo; quarantines the rest for the matching user', async () => {
      const db = createTestDB(`db-test-hint-${Math.random()}`);
      const baseJob = {
        cachedAt: new Date().toISOString(),
        hasPendingOutbox: true,
        submitState: 'none' as const,
        serverRemoved: false,
        predictedDraftVersion: 1,
      };
      await db.jobs.bulkAdd([
        {
          ...baseJob,
          userId: LEGACY_USER_ID,
          id: 'job-a',
          job: { id: 'job-a', assignedTo: 'user-1' } as never,
        },
        {
          ...baseJob,
          userId: LEGACY_USER_ID,
          id: 'job-b',
          job: { id: 'job-b', assignedTo: 'user-2', assignedToName: 'Other Tech' } as never,
        },
      ]);
      const baseRow = {
        method: 'PUT' as const,
        body: {},
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        attempts: 0,
        lastError: null,
        lastResult: null,
      };
      await db.outbox.bulkAdd([
        {
          ...baseRow,
          id: 'row-a',
          userId: LEGACY_USER_ID,
          sequence: 1,
          jobId: 'job-a',
          path: '/jobs/job-a/items/x',
        },
        {
          ...baseRow,
          id: 'row-b',
          userId: LEGACY_USER_ID,
          sequence: 2,
          jobId: 'job-b',
          path: '/jobs/job-b/items/x',
        },
      ]);

      await claimLegacyRows(db, 'user-1');

      // user-1 gets exactly the work the SERVER says was theirs…
      expect((await db.outbox.get('row-a'))?.userId).toBe('user-1');
      expect(await db.jobs.get(['user-1', 'job-a'])).toBeDefined();
      // …and user-2's work is QUARANTINED, not claimed: still legacy-owned,
      // untouched, waiting for user-2.
      expect((await db.outbox.get('row-b'))?.userId).toBe(LEGACY_USER_ID);
      expect(await db.jobs.get([LEGACY_USER_ID, 'job-b'])).toBeDefined();
      expect(await db.jobs.get(['user-1', 'job-b'])).toBeUndefined();

      // The matching user's later sign-in claims the quarantined rows.
      await claimLegacyRows(db, 'user-2');
      expect((await db.outbox.get('row-b'))?.userId).toBe('user-2');
      expect(await db.jobs.get(['user-2', 'job-b'])).toBeDefined();
      expect(await db.jobs.get([LEGACY_USER_ID, 'job-b'])).toBeUndefined();
      await db.delete();
    });

    it('H-4: falls back to first-principal ONLY for rows with no surviving job or no assignee', async () => {
      const db = createTestDB(`db-test-hint-fallback-${Math.random()}`);
      await db.outbox.add({
        id: 'orphan-row',
        userId: LEGACY_USER_ID,
        sequence: 1,
        jobId: 'ghost-job', // no cached job survives for it
        method: 'PUT',
        path: '/jobs/ghost-job/items/x',
        body: {},
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        lastError: null,
        lastResult: null,
      });
      await claimLegacyRows(db, 'user-9');
      expect((await db.outbox.get('orphan-row'))?.userId).toBe('user-9');
      await db.delete();
    });

    it('H-4/claim-collision: a legacy job copy never overwrites a copy the user already claimed', async () => {
      const db = createTestDB(`db-test-collision-${Math.random()}`);
      const base = {
        id: 'job-1',
        cachedAt: new Date().toISOString(),
        hasPendingOutbox: false,
        submitState: 'none' as const,
        serverRemoved: false,
      };
      await db.jobs.bulkAdd([
        {
          ...base,
          userId: 'user-1',
          job: { id: 'job-1', assignedTo: 'user-1' } as never,
          predictedDraftVersion: 9, // the live, claimed copy
        },
        {
          ...base,
          userId: LEGACY_USER_ID,
          job: { id: 'job-1', assignedTo: 'user-1' } as never,
          predictedDraftVersion: 2, // stale legacy duplicate
        },
      ]);
      await claimLegacyRows(db, 'user-1');
      expect((await db.jobs.get(['user-1', 'job-1']))?.predictedDraftVersion).toBe(9);
      expect(await db.jobs.get([LEGACY_USER_ID, 'job-1'])).toBeUndefined();
      await db.delete();
    });

    it('H-4: legacyHoldSummary reports quarantined work (count + attested owner names) and empty when clean', async () => {
      const db = createTestDB(`db-test-holdsummary-${Math.random()}`);
      expect(await legacyHoldSummary(db)).toEqual({ count: 0, names: [] });

      await db.jobs.add({
        userId: LEGACY_USER_ID,
        id: 'job-b',
        job: { id: 'job-b', assignedTo: 'user-2', assignedToName: 'Other Tech' } as never,
        cachedAt: new Date().toISOString(),
        hasPendingOutbox: true,
        submitState: 'none',
        serverRemoved: false,
        predictedDraftVersion: 1,
      });
      await db.outbox.bulkAdd(
        [1, 2].map((n) => ({
          id: `held-${n}`,
          userId: LEGACY_USER_ID,
          sequence: n,
          jobId: 'job-b',
          method: 'PUT' as const,
          path: `/jobs/job-b/items/item-${n}`,
          body: {},
          ifMatch: n,
          clientRecordedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          status: 'pending' as const,
          attempts: 0,
          lastError: null,
          lastResult: null,
        })),
      );
      // A quarantined row whose legacy job carries NO display name still
      // counts — the banner just cannot name its owner.
      await db.jobs.add({
        userId: LEGACY_USER_ID,
        id: 'job-c',
        job: { id: 'job-c', assignedTo: 'user-3' } as never,
        cachedAt: new Date().toISOString(),
        hasPendingOutbox: true,
        submitState: 'none',
        serverRemoved: false,
        predictedDraftVersion: 1,
      });
      await db.outbox.add({
        id: 'held-3',
        userId: LEGACY_USER_ID,
        sequence: 3,
        jobId: 'job-c',
        method: 'PUT' as const,
        path: '/jobs/job-c/items/item-1',
        body: {},
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: 'pending' as const,
        attempts: 0,
        lastError: null,
        lastResult: null,
      });
      expect(await legacyHoldSummary(db)).toEqual({ count: 3, names: ['Other Tech'] });
      await db.delete();
    });

    it('the v2 upgrade preserves an already-stamped userId and copes with an empty v1 jobs table', async () => {
      const name = `db-test-prestamped-${Math.random()}`;
      const v1 = new Dexie(name);
      v1.version(1).stores({
        outbox: 'id, sequence, jobId, status, [jobId+status]',
        jobs: 'id, submitState',
        meta: 'key',
      });
      // Defensive branch: a row that somehow already carries a string
      // userId must keep it — the stamp never overwrites.
      await v1.table('outbox').add({
        id: 'pre-stamped',
        userId: 'user-7',
        sequence: 1,
        jobId: 'job-1',
        method: 'PUT',
        path: '/jobs/job-1/items/item-1',
        body: {},
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        lastError: null,
        lastResult: null,
      });
      // jobs table left EMPTY — the copy loop must be a clean no-op.
      v1.close();

      const db = createTestDB(name);
      await db.open();
      expect((await db.outbox.get('pre-stamped'))?.userId).toBe('user-7');
      expect(await db.jobs.count()).toBe(0);
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
