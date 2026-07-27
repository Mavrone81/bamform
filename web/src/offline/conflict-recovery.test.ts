import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDB, type BamFormDB } from './db';
import { MockSyncTransport } from '../api/mock-transport';
import { append, drain, pendingCountForJob, jobOutboxCounts } from './outbox';
import { recoverJobConflicts } from './conflict-recovery';
import { getCachedJob, submitJob } from './sync-engine';

type JobT = import('../api/generated/openapi-types').components['schemas']['Job'];

function makeJob(overrides: Partial<JobT> = {}): JobT {
  return {
    id: 'job-1',
    jobNumber: 'PM-2026-000001',
    assetCode: 'AW01',
    frequency: 'M3',
    dueOn: '2026-08-01',
    status: 'IN_PROGRESS',
    draftVersion: 7,
    templateRevision: {
      id: 'rev-1',
      formTemplateId: 'tpl-1',
      revisionCode: 'A',
      sequenceOrdinal: 1,
      status: 'CURRENT',
    },
    ...overrides,
  } as JobT;
}

let db: BamFormDB;
let counter = 0;

beforeEach(async () => {
  db = createTestDB(`test-recovery-${counter++}-${Math.random()}`);
  await db.jobs.put({
    userId: 'user-1',
    id: 'job-1',
    job: makeJob({ draftVersion: 1 }),
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
    userId: 'user-1',
    jobId: 'job-1',
    method: 'PUT' as const,
    path: '/jobs/job-1/items/item-1',
    body: { status: 'DONE' },
    ifMatch: 1,
    clientRecordedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Wedges the device: two queued mutations both 409 (as a real
 * version-desync makes them — see SYS-5 scenario b), leaving conflict rows
 * that no drain will ever touch. Returns their original ids. */
async function wedge(transport: MockSyncTransport): Promise<[string, string]> {
  const a = (await append(db, input({ ifMatch: 1 }))) as { ok: true; entry: { id: string } };
  const b = (await append(db, input({ path: '/jobs/job-1/items/item-2', ifMatch: 2 }))) as {
    ok: true;
    entry: { id: string };
  };
  transport.forceConflict(a.entry.id, b.entry.id);
  await drain(db, transport, 'user-1');
  expect(await jobOutboxCounts(db, 'user-1', 'job-1')).toEqual({
    total: 2,
    sendable: 0,
    conflict: 2,
  });
  return [a.entry.id, b.entry.id];
}

describe('recoverJobConflicts — SYS-5: the wedge is recoverable through code, so the UI can offer it', () => {
  it("keep-mine: refreshes ifMatch from the server's CURRENT draftVersion (never replays the stale one), mints fresh ids, resends, and the job becomes submittable", async () => {
    const transport = new MockSyncTransport();
    transport.seedJob(makeJob({ draftVersion: 7 })); // server has moved on
    const [oldA, oldB] = await wedge(transport);

    const result = await recoverJobConflicts(db, transport, 'user-1', 'job-1', 'keep-mine');
    expect(result.ok).toBe(true);

    // The stale-ifMatch trap from the review: the retried rows must carry
    // the server's current version chain (7, 8), NOT the stale 1, 2.
    const rows = (await db.outbox.where('[userId+jobId]').equals(['user-1', 'job-1']).toArray())
      // recovery may already have drained them — if so the outbox is empty
      .sort((x, y) => x.sequence - y.sequence);
    if (rows.length > 0) {
      expect(rows.map((r) => r.ifMatch)).toEqual([7, 8]);
      expect(rows.map((r) => r.id)).not.toContain(oldA);
      expect(rows.map((r) => r.id)).not.toContain(oldB);
    }

    // Either way, a drain leaves the job clean and submittable again.
    await drain(db, transport, 'user-1');
    expect(await pendingCountForJob(db, 'user-1', 'job-1')).toBe(0);
    const cached = await getCachedJob(db, 'user-1', 'job-1');
    expect(cached?.hasPendingOutbox).toBe(false);

    const submit = await submitJob(db, transport, 'user-1', 'job-1');
    expect(submit.ok).toBe(true);
  });

  it('keep-mine: advances the cached predictedDraftVersion to the rebuilt chain so the NEXT edit does not re-conflict', async () => {
    const transport = new MockSyncTransport();
    transport.seedJob(makeJob({ draftVersion: 7 }));
    // Wedge WITHOUT auto-drain so the rebuilt rows are still observable.
    const a = (await append(db, input({ ifMatch: 1 }))) as { ok: true; entry: { id: string } };
    transport.forceConflict(a.entry.id);
    await drain(db, transport, 'user-1');

    // Block the recovery's own resend so we can inspect the rebuilt state.
    const realDrain = transport.drainOutbox.bind(transport);
    transport.drainOutbox = async () => {
      throw new Error('offline again');
    };
    await recoverJobConflicts(db, transport, 'user-1', 'job-1', 'keep-mine');
    transport.drainOutbox = realDrain;

    const rows = await db.outbox.where('[userId+jobId]').equals(['user-1', 'job-1']).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].ifMatch).toBe(7);
    const cached = await getCachedJob(db, 'user-1', 'job-1');
    expect(cached?.predictedDraftVersion).toBe(8); // server 7 + 1 rebuilt row
  });

  it('accept-server: discards the conflicted local edits, refetches the server job, and the job is clean', async () => {
    const transport = new MockSyncTransport();
    transport.seedJob(makeJob({ draftVersion: 7, status: 'IN_PROGRESS' }));
    await wedge(transport);

    const result = await recoverJobConflicts(db, transport, 'user-1', 'job-1', 'accept-server');
    expect(result).toEqual({ ok: true, action: 'accepted-server', discarded: 2, retried: 0 });

    expect(await pendingCountForJob(db, 'user-1', 'job-1')).toBe(0);
    const cached = await getCachedJob(db, 'user-1', 'job-1');
    expect(cached?.hasPendingOutbox).toBe(false);
    expect(cached?.job.draftVersion).toBe(7); // the refetched server truth
    expect(cached?.predictedDraftVersion).toBe(7);
  });

  it('accept-server: also clears retained non-409 failures (they can never succeed by resending unchanged)', async () => {
    const transport = new MockSyncTransport();
    transport.seedJob(makeJob({ draftVersion: 7 }));
    const a = (await append(db, input())) as { ok: true; entry: { id: string } };
    const realDrain = transport.drainOutbox.bind(transport);
    transport.drainOutbox = async (mutations) =>
      Promise.resolve({
        results: mutations.map((m) => ({
          id: m.id,
          status: 422,
          applied: false,
          problem: { type: 'about:blank', title: 'unprocessable', status: 422 },
        })),
      });
    await drain(db, transport, 'user-1');
    expect((await db.outbox.get(a.entry.id))?.status).toBe('failed');
    transport.drainOutbox = realDrain;

    const result = await recoverJobConflicts(db, transport, 'user-1', 'job-1', 'accept-server');
    expect(result.ok).toBe(true);
    expect(await pendingCountForJob(db, 'user-1', 'job-1')).toBe(0);
  });

  it('reports offline (and changes nothing) when the server cannot be reached — recovery needs the current server state', async () => {
    const transport = new MockSyncTransport();
    transport.seedJob(makeJob({ draftVersion: 7 }));
    const [oldA, oldB] = await wedge(transport);

    transport.networkDown = true;
    const result = await recoverJobConflicts(db, transport, 'user-1', 'job-1', 'keep-mine');
    expect(result).toEqual({ ok: false, reason: 'offline' });

    // Untouched: same rows, same ids, still conflict — nothing was lost or
    // half-rebuilt.
    expect((await db.outbox.get(oldA))?.status).toBe('conflict');
    expect((await db.outbox.get(oldB))?.status).toBe('conflict');
  });

  it("never touches another user's rows for the same job", async () => {
    const transport = new MockSyncTransport();
    transport.seedJob(makeJob({ draftVersion: 7 }));
    await wedge(transport);
    const other = (await append(db, input({ userId: 'user-2', ifMatch: 3 }))) as {
      ok: true;
      entry: { id: string };
    };

    await recoverJobConflicts(db, transport, 'user-1', 'job-1', 'accept-server');
    const untouched = await db.outbox.get(other.entry.id);
    expect(untouched?.status).toBe('pending');
    expect(untouched?.ifMatch).toBe(3);
  });
});
