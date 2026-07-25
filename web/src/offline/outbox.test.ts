import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDB, type BamFormDB } from './db';
import { MockSyncTransport } from '../api/mock-transport';
import {
  append,
  drain,
  drainAll,
  discardConflict,
  hasConflicts,
  isQuotaExceeded,
  listDrainable,
  pendingCountForJob,
  retryConflictWithNewId,
  MAX_BATCH_SIZE,
} from './outbox';

let db: BamFormDB;
let dbCounter = 0;

beforeEach(async () => {
  db = createTestDB(`test-outbox-${dbCounter++}-${Math.random()}`);
  await db.jobs.put({
    id: 'job-1',
    job: {} as never,
    cachedAt: new Date().toISOString(),
    hasPendingOutbox: false,
    submitState: 'none',
    serverRemoved: false,
    predictedDraftVersion: 1,
  });
});

afterEach(async () => {
  await db.delete();
});

function input(overrides: Partial<Parameters<typeof append>[1]> = {}) {
  return {
    jobId: 'job-1',
    method: 'PUT' as const,
    path: '/jobs/job-1/items/item-1',
    body: { status: 'DONE' },
    ifMatch: 1,
    clientRecordedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('append — durability and quota (O-11)', () => {
  it('writes an entry synchronously and it is durable in IndexedDB', async () => {
    const result = await append(db, input());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const stored = await db.outbox.get(result.entry.id);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('pending');
  });

  it('assigns a client-generated UUIDv7 that IS the entry id (doubles as Idempotency-Key, ADR-008)', async () => {
    const result = await append(db, input());
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('assigns strictly increasing sequence numbers across appends', async () => {
    const a = await append(db, input());
    const b = await append(db, input());
    const c = await append(db, input());
    if (!a.ok || !b.ok || !c.ok) throw new Error('unreachable');
    expect(a.entry.sequence).toBeLessThan(b.entry.sequence);
    expect(b.entry.sequence).toBeLessThan(c.entry.sequence);
  });

  it('keeps sequence monotonic across acked (deleted) rows — never reused', async () => {
    const a = await append(db, input());
    if (!a.ok) throw new Error('unreachable');
    const transport = new MockSyncTransport();
    await drain(db, transport); // acks + deletes `a`
    const b = await append(db, input());
    if (!b.ok) throw new Error('unreachable');
    expect(b.entry.sequence).toBeGreaterThan(a.entry.sequence);
  });

  it('marks the owning job dirty (hasPendingOutbox) on append', async () => {
    await append(db, input());
    const job = await db.jobs.get('job-1');
    expect(job?.hasPendingOutbox).toBe(true);
  });

  it('returns quota-exceeded and writes NOTHING when the transaction store throws QuotaExceededError', async () => {
    const original = db.outbox.add.bind(db.outbox);
    // Simulate the device's storage quota being exhausted mid-write.
    db.outbox.add = (() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }) as typeof db.outbox.add;

    const result = await append(db, input());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('quota-exceeded');
    expect((result.error as { name?: string }).name).toBe('QuotaExceededError');

    // No silent loss AND no silent partial success: nothing was written.
    const count = await db.outbox.count();
    expect(count).toBe(0);
    const job = await db.jobs.get('job-1');
    expect(job?.hasPendingOutbox).toBe(false);

    db.outbox.add = original;
  });

  it('re-throws non-quota errors instead of masking them as quota-exceeded', async () => {
    db.outbox.add = (() => {
      throw new Error('disk on fire');
    }) as typeof db.outbox.add;
    await expect(append(db, input())).rejects.toThrow('disk on fire');
  });
});

describe('isQuotaExceeded', () => {
  it('recognises a raw DOMException named QuotaExceededError', () => {
    expect(isQuotaExceeded(new DOMException('full', 'QuotaExceededError'))).toBe(true);
  });

  it('rejects a raw DOMException with a different name', () => {
    expect(isQuotaExceeded(new DOMException('nope', 'NotFoundError'))).toBe(false);
  });

  it('recognises a Dexie-style error object carrying the same name', () => {
    expect(isQuotaExceeded({ name: 'QuotaExceededError' })).toBe(true);
  });

  it('rejects non-error values', () => {
    expect(isQuotaExceeded('boom')).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded(undefined)).toBe(false);
    expect(isQuotaExceeded({ name: 'SomethingElse' })).toBe(false);
  });
});

describe('drain — non-negotiable #1: cleared ONLY after server ack (O-15)', () => {
  it('deletes the outbox row when the server returns applied: true', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    const summary = await drain(db, transport);
    expect(summary.acked).toBe(1);
    expect(await db.outbox.get(entry.id)).toBeUndefined();
  });

  it('O-15: forced failure AFTER the server commits leaves the row intact, and the mutation is applied exactly once on retry', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.dropResponseOnceFor(entry.id);

    // First attempt: server applies it, then the response is lost.
    const first = await drain(db, transport);
    expect(first.networkError).toBe(true);
    expect(first.acked).toBe(0);
    // Row must still be present — this is the entire point of O-15.
    const stillThere = await db.outbox.get(entry.id);
    expect(stillThere).toBeDefined();
    expect(stillThere?.status).toBe('pending');
    expect(transport.timesApplied(entry.id)).toBe(1); // server-side: applied once already

    // Retry with the SAME id (idempotency key) — server replays, does not re-apply.
    const second = await drain(db, transport);
    expect(second.acked).toBe(1);
    expect(await db.outbox.get(entry.id)).toBeUndefined();
    expect(transport.timesApplied(entry.id)).toBe(1); // still exactly once, never twice
  });

  it('two concurrent drain() calls never both claim the same row (regression: found via O-16 E2E)', async () => {
    // Models `watchOnlineAndDrain`'s `online` listener racing a second,
    // independent trigger for the same reconnect (e.g. the browser's own
    // `online` event alongside a manual dispatch) — both call drain() at
    // effectively the same instant. Selecting the batch and marking it
    // 'sending' must happen atomically, or both calls can read the row
    // while it is still 'pending' and both send it — a real duplicate
    // transmission, not a safe idempotent retry of the SAME send.
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(
        (await append(db, input({ path: `/jobs/job-1/items/item-${i}` }))) as {
          ok: true;
          entry: { id: string };
        },
      );
    }
    const transport = new MockSyncTransport();

    const [summaryA, summaryB] = await Promise.all([drain(db, transport), drain(db, transport)]);

    const totalSent = summaryA.attempted + summaryB.attempted;
    expect(totalSent).toBe(5); // each row claimed by exactly one of the two calls
    for (const e of entries) {
      expect(transport.timesApplied(e.entry.id)).toBe(1); // never sent twice
    }
    expect(await db.outbox.count()).toBe(0);
  });

  it('O-05: replaying an entire outbox batch (simulated double-send) never double-applies', async () => {
    const a = (await append(db, input())) as { ok: true; entry: { id: string } };
    const b = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();

    // Build the exact same batch twice and send it directly through the
    // transport (bypassing outbox bookkeeping) to model a genuine duplicate
    // transmission — e.g. a retried HTTP request whose first attempt DID
    // arrive, and a naive client resent it anyway.
    const mutations = [
      {
        id: a.entry.id,
        sequence: 1,
        method: 'PUT' as const,
        path: 'x',
        body: {},
        clientRecordedAt: '',
        ifMatch: null,
      },
      {
        id: b.entry.id,
        sequence: 2,
        method: 'PUT' as const,
        path: 'x',
        body: {},
        clientRecordedAt: '',
        ifMatch: null,
      },
    ];
    await transport.drainOutbox(mutations);
    await transport.drainOutbox(mutations); // exact replay

    expect(transport.timesApplied(a.entry.id)).toBe(1);
    expect(transport.timesApplied(b.entry.id)).toBe(1);
  });

  it('never sends more than MAX_BATCH_SIZE mutations, and only the oldest by sequence (O-16)', async () => {
    for (let i = 0; i < MAX_BATCH_SIZE + 25; i++) {
      await append(db, input({ path: `/jobs/job-1/items/item-${i}` }));
    }
    const batch = await listDrainable(db);
    expect(batch.length).toBe(MAX_BATCH_SIZE);
    for (let i = 1; i < batch.length; i++) {
      expect(batch[i].sequence).toBeGreaterThan(batch[i - 1].sequence);
    }
  });

  it('drainAll walks a queue larger than one batch to completion', async () => {
    for (let i = 0; i < MAX_BATCH_SIZE + 25; i++) {
      await append(db, input({ path: `/jobs/job-1/items/item-${i}` }));
    }
    const transport = new MockSyncTransport();
    const summaries = await drainAll(db, transport);
    expect(summaries.reduce((n, s) => n + s.acked, 0)).toBe(MAX_BATCH_SIZE + 25);
    expect(await db.outbox.count()).toBe(0);
  });

  it('a thrown transport error (network down) reverts every row to pending, clearing none', async () => {
    const entries = [
      (await append(db, input())) as { ok: true; entry: { id: string } },
      (await append(db, input())) as { ok: true; entry: { id: string } },
    ];
    const transport = new MockSyncTransport();
    transport.networkDown = true;

    const summary = await drain(db, transport);
    expect(summary.networkError).toBe(true);
    expect(summary.acked).toBe(0);
    for (const e of entries) {
      const row = await db.outbox.get(e.entry.id);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(1);
    }
  });

  it('O-08: a 409 on one mutation is retained, the rest of the batch still applies, and the conflict is surfaced', async () => {
    const good = (await append(db, input())) as { ok: true; entry: { id: string } };
    const bad = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.forceConflict(bad.entry.id);

    const summary = await drain(db, transport);
    expect(summary.acked).toBe(1);
    expect(summary.conflicted).toBe(1);
    expect(await db.outbox.get(good.entry.id)).toBeUndefined();
    const conflictRow = await db.outbox.get(bad.entry.id);
    expect(conflictRow?.status).toBe('conflict');
    expect(conflictRow?.lastResult?.status).toBe(409);
    expect(await hasConflicts(db, 'job-1')).toBe(true);
  });

  it('conflict rows are never auto-resent by drain()', async () => {
    const bad = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.forceConflict(bad.entry.id);
    await drain(db, transport); // -> conflict

    const before = transport.timesApplied(bad.entry.id);
    await drain(db, transport); // should be a no-op: nothing drainable
    expect(transport.timesApplied(bad.entry.id)).toBe(before);
    expect((await db.outbox.get(bad.entry.id))?.status).toBe('conflict');
  });

  it('retryConflictWithNewId mints a fresh id and resends after technician resolution', async () => {
    const bad = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.forceConflict(bad.entry.id);
    await drain(db, transport);

    await retryConflictWithNewId(db, bad.entry.id);
    expect(await db.outbox.get(bad.entry.id)).toBeUndefined(); // old id gone
    const pending = await listDrainable(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(bad.entry.id);

    const summary = await drain(db, transport);
    expect(summary.acked).toBe(1);
  });

  it('discardConflict removes the local edit and clears the job dirty flag', async () => {
    const bad = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.forceConflict(bad.entry.id);
    await drain(db, transport);

    await discardConflict(db, bad.entry.id);
    expect(await db.outbox.get(bad.entry.id)).toBeUndefined();
    expect(await pendingCountForJob(db, 'job-1')).toBe(0);
    const job = await db.jobs.get('job-1');
    expect(job?.hasPendingOutbox).toBe(false);
  });

  it('a missing id in the server response is treated as not-applied, not as success', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    const realDrain = transport.drainOutbox.bind(transport);
    transport.drainOutbox = async (mutations) => {
      const res = await realDrain(mutations);
      return { ...res, results: [] }; // simulate a malformed/partial response
    };

    const summary = await drain(db, transport);
    expect(summary.acked).toBe(0);
    expect(summary.failed).toBe(1);
    const row = await db.outbox.get(entry.id);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('missing from server response');
  });

  it('draining an empty outbox is a safe no-op', async () => {
    const transport = new MockSyncTransport();
    const summary = await drain(db, transport);
    expect(summary).toEqual({
      attempted: 0,
      acked: 0,
      conflicted: 0,
      failed: 0,
      networkError: false,
    });
  });

  it('records a non-Error thrown value (e.g. a raw string rejection) without crashing', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.drainOutbox = async () => {
      throw 'raw string failure';
    };
    const summary = await drain(db, transport);
    expect(summary.networkError).toBe(true);
    const row = await db.outbox.get(entry.id);
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toBe('raw string failure');
  });

  it('a 409 result missing an explicit problem body still records a retained conflict', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.drainOutbox = async (mutations) =>
      Promise.resolve({
        results: mutations.map((m) => ({ id: m.id, status: 409, applied: false })),
      });
    const summary = await drain(db, transport);
    expect(summary.conflicted).toBe(1);
    const row = await db.outbox.get(entry.id);
    expect(row?.status).toBe('conflict');
    expect(row?.lastResult).toEqual({ status: 409, problem: null });
  });

  it('a non-409 rejection with a result present (e.g. 422) is retained as failed, with its problem body stored', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.drainOutbox = async (mutations) =>
      Promise.resolve({
        results: mutations.map((m) => ({
          id: m.id,
          status: 422,
          applied: false,
          problem: { type: 'about:blank', title: 'unprocessable', status: 422 },
        })),
      });
    const summary = await drain(db, transport);
    expect(summary.failed).toBe(1);
    const row = await db.outbox.get(entry.id);
    expect(row?.status).toBe('failed');
    expect(row?.lastResult).toEqual({
      status: 422,
      problem: { type: 'about:blank', title: 'unprocessable', status: 422 },
    });
    expect(row?.lastError).toBeNull();
  });
});

describe('drainAll — stops on network failure instead of hammering a dead connection', () => {
  it('stops after the first networkError summary', async () => {
    await append(db, input());
    await append(db, input());
    const transport = new MockSyncTransport();
    transport.networkDown = true;
    const summaries = await drainAll(db, transport);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].networkError).toBe(true);
  });
});

describe('retryConflictWithNewId / discardConflict — no-op on rows that no longer apply', () => {
  it('retryConflictWithNewId is a no-op for an id that does not exist', async () => {
    await expect(retryConflictWithNewId(db, 'does-not-exist')).resolves.toBeUndefined();
  });

  it('retryConflictWithNewId is a no-op for a row that is not in conflict', async () => {
    const { entry } = (await append(db, input())) as { ok: true; entry: { id: string } };
    await retryConflictWithNewId(db, entry.id); // status is 'pending', not 'conflict'
    const row = await db.outbox.get(entry.id);
    expect(row?.status).toBe('pending'); // untouched
  });

  it('discardConflict is a no-op for an id that does not exist', async () => {
    await expect(discardConflict(db, 'does-not-exist')).resolves.toBeUndefined();
  });
});
