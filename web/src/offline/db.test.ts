import { describe, expect, it } from 'vitest';
import { createTestDB, getDB, recoverStuckSendingRows, type OutboxEntry } from './db';
import { append, drain } from './outbox';
import { MockSyncTransport } from '../api/mock-transport';

function stuckSendingRow(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: '018e0000-0000-7000-8000-000000000001',
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
    await a.jobs.put({ id: '1', job: {} as never, cachedAt: '', hasPendingOutbox: false, submitState: 'none', serverRemoved: false, predictedDraftVersion: 1 });
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
      const summary = await drain(session2, transport);
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
        jobId: 'job-1',
        method: 'PUT',
        path: '/jobs/job-1/items/item-1',
        body: { status: 'DONE' },
        ifMatch: 1,
        clientRecordedAt: new Date().toISOString(),
      })) as { ok: true; entry: { id: string } };
      const transport = new MockSyncTransport();
      await drain(session1, transport); // fully acked and cleared before "the tab dies"
      session1.close();

      const session2 = createTestDB(name);
      await session2.open();
      expect(await session2.outbox.get(appended.entry.id)).toBeUndefined();
      expect(await session2.outbox.count()).toBe(0);
      await session2.delete();
    });
  });
});
