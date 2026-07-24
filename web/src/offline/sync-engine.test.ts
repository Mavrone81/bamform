import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB, type BamFormDB } from './db';
import { MockSyncTransport } from '../api/mock-transport';
import { append, drain, pendingCountForJob } from './outbox';
import {
  bootstrap,
  getClockSkew,
  submitJob,
  jobSyncState,
  watchOnlineAndDrain,
  triggerDrainIfOnline,
  appendJobMutation,
  getCachedJob,
  listCachedJobs,
} from './sync-engine';

type JobT = import('../api/generated/openapi-types').components['schemas']['Job'];

function makeJob(overrides: Partial<JobT> = {}): JobT {
  return {
    id: 'job-1',
    jobNumber: 'PM-2026-000001',
    assetCode: 'AW01',
    frequency: 'M3',
    dueOn: '2026-08-01',
    status: 'IN_PROGRESS',
    templateRevision: { id: 'rev-1', formTemplateId: 'tpl-1', revisionCode: 'A', sequenceOrdinal: 1, status: 'CURRENT' },
    ...overrides,
  } as JobT;
}

let db: BamFormDB;
let counter = 0;

beforeEach(() => {
  db = createTestDB(`test-sync-${counter++}-${Math.random()}`);
});

afterEach(async () => {
  await db.delete();
  vi.restoreAllMocks();
});

describe('bootstrap', () => {
  it('caches jobs from the bootstrap payload and stores the sync token', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [makeJob()], syncToken: 'tok-1' });

    const summary = await bootstrap(db, transport);
    expect(summary.jobsUpserted).toBe(1);
    const cached = await getCachedJob(db, 'job-1');
    expect(cached?.job.id).toBe('job-1');
    const tokenRow = await db.meta.get('syncToken');
    expect(tokenRow?.value).toBe('tok-1');
  });

  it('O-09: flags clock skew when the device clock is far ahead of the server', async () => {
    // Fake only `Date` — Dexie/fake-indexeddb schedule their own transaction
    // completion via real timers/microtasks, which would hang forever under
    // a fully faked clock that nothing ever advances.
    vi.useFakeTimers({ toFake: ['Date'] });
    const skewedNow = new Date('2026-07-24T12:00:00.000Z');
    vi.setSystemTime(skewedNow);
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ serverTime: '2026-07-24T09:55:00.000Z' }); // 2h05m behind local clock

    const summary = await bootstrap(db, transport);
    expect(summary.skewDetected).toBe(true);
    expect(summary.clockSkewMs).toBeGreaterThan(0);

    const stored = await getClockSkew(db);
    expect(stored?.skewDetected).toBe(true);
    // Both timestamps are retained (PR-063's "both timestamps stored" rule
    // applied here to the bootstrap skew check as well).
    expect(stored?.serverTime).toBe('2026-07-24T09:55:00.000Z');
    expect(stored?.localTime).toBe(skewedNow.toISOString());
    vi.useRealTimers();
  });

  it('does not flag skew for an ordinary few-second difference', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ serverTime: new Date().toISOString() });
    const summary = await bootstrap(db, transport);
    expect(summary.skewDetected).toBe(false);
  });

  it('O-10: a job with pending local edits keeps its cached (frozen) template revision on a later bootstrap', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [makeJob({ templateRevision: { id: 'rev-1', formTemplateId: 'tpl-1', revisionCode: 'A', sequenceOrdinal: 1, status: 'CURRENT' } })] });
    await bootstrap(db, transport);
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });

    // A new revision is issued for the asset type while this job sits
    // offline with unsynced work — the (hypothetical, defensive) incoming
    // snapshot carries a different revision for the SAME job id.
    transport.seedBootstrap({
      jobs: [makeJob({ templateRevision: { id: 'rev-2', formTemplateId: 'tpl-1', revisionCode: 'B', sequenceOrdinal: 2, status: 'CURRENT' } })],
    });
    const summary = await bootstrap(db, transport);
    expect(summary.jobsProtected).toBe(1);
    expect(summary.jobsUpserted).toBe(0);

    const cached = await getCachedJob(db, 'job-1');
    expect(cached?.job.templateRevision?.id).toBe('rev-1'); // frozen, not rev-2
  });

  it('fully refreshes a job snapshot when it has no pending local edits', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [makeJob({ status: 'ASSIGNED' })] });
    await bootstrap(db, transport);

    transport.seedBootstrap({ jobs: [makeJob({ status: 'IN_PROGRESS' })] });
    const summary = await bootstrap(db, transport);
    expect(summary.jobsUpserted).toBe(1);
    expect(summary.jobsProtected).toBe(0);
    const cached = await getCachedJob(db, 'job-1');
    expect(cached?.job.status).toBe('IN_PROGRESS');
  });

  it('O-14: a job removed server-side while it has pending local work is flagged, not deleted', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [makeJob()] });
    await bootstrap(db, transport);
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });

    transport.seedBootstrap({ jobs: [], deletedJobIds: ['job-1'] });
    const summary = await bootstrap(db, transport);
    expect(summary.jobsFlaggedRemovedWithPendingWork).toBe(1);
    expect(summary.jobsRemoved).toBe(0);

    const cached = await getCachedJob(db, 'job-1');
    expect(cached).toBeDefined(); // NOT deleted
    expect(cached?.serverRemoved).toBe(true);
  });

  it('removes a job cleanly when the server reports it deleted and there is no pending work', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [makeJob()] });
    await bootstrap(db, transport);

    transport.seedBootstrap({ jobs: [], deletedJobIds: ['job-1'] });
    const summary = await bootstrap(db, transport);
    expect(summary.jobsRemoved).toBe(1);
    expect(await getCachedJob(db, 'job-1')).toBeUndefined();
  });

  it('ignores a deletedJobIds entry for a job never cached locally', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [], deletedJobIds: ['never-seen'] });
    const summary = await bootstrap(db, transport);
    expect(summary.jobsRemoved).toBe(0);
    expect(summary.jobsFlaggedRemovedWithPendingWork).toBe(0);
  });

  it('listCachedJobs returns every job the device has bootstrapped', async () => {
    const transport = new MockSyncTransport();
    transport.seedBootstrap({ jobs: [makeJob({ id: 'job-1' }), makeJob({ id: 'job-2' })] });
    await bootstrap(db, transport);
    const jobs = await listCachedJobs(db);
    expect(jobs.map((j) => j.id).sort()).toEqual(['job-1', 'job-2']);
  });
});

describe('submitJob — non-negotiable #2: separate atomic call after every mutation is acknowledged', () => {
  beforeEach(async () => {
    await db.jobs.put({
      id: 'job-1',
      job: makeJob(),
      cachedAt: new Date().toISOString(),
      hasPendingOutbox: false,
      submitState: 'none',
      serverRemoved: false,
      predictedDraftVersion: 1,
    });
  });

  it('refuses to submit while outbox mutations for the job are still pending', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    const result = await submitJob(db, transport, 'job-1');
    expect(result).toEqual({ ok: false, reason: 'pending-mutations', pendingCount: 1 });
  });

  it('refuses to submit while a mutation is retained in conflict', async () => {
    const { entry } = (await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    })) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.forceConflict(entry.id);
    await drain(db, transport);

    const result = await submitJob(db, transport, 'job-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('pending-mutations');
  });

  it('submits once all mutations are acknowledged, as its own call (never folded into drainOutbox)', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    const drainSpy = vi.spyOn(transport, 'drainOutbox');
    const submitSpy = vi.spyOn(transport, 'submitJob');

    await drain(db, transport);
    const result = await submitJob(db, transport, 'job-1');

    expect(result).toEqual({ ok: true, status: 200 });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    // The submit call must be separate: it never appears as part of the
    // arguments passed to drainOutbox.
    for (const call of drainSpy.mock.calls) {
      const mutations = call[0];
      expect(mutations.some((m) => m.path.includes('/submit'))).toBe(false);
    }

    const cached = await getCachedJob(db, 'job-1');
    expect(cached?.submitState).toBe('submitted');
  });

  it('refuses to submit a job flagged server-removed (O-14)', async () => {
    const job = await db.jobs.get('job-1');
    await db.jobs.put({ ...job!, serverRemoved: true });
    const transport = new MockSyncTransport();
    const result = await submitJob(db, transport, 'job-1');
    expect(result).toEqual({ ok: false, reason: 'server-removed' });
  });

  it('resets submitState and surfaces the server rejection if submit itself is rejected', async () => {
    const transport = new MockSyncTransport();
    const problem = {
      type: 'https://form.bevorasg.com/errors/incomplete-record',
      title: 'incomplete-record',
      status: 422,
    };
    transport.submitJob = async () => ({ status: 422, ok: false, problem });
    const result = await submitJob(db, transport, 'job-1');
    expect(result).toEqual({ ok: false, reason: 'server-rejected', status: 422, problem });
    const cached = await getCachedJob(db, 'job-1');
    expect(cached?.submitState).toBe('none');
  });

  it('is a no-op-safe guard even for a job not present in the local cache', async () => {
    const transport = new MockSyncTransport();
    const result = await submitJob(db, transport, 'ghost-job');
    expect(result).toEqual({ ok: true, status: 200 });
  });
});

describe('jobSyncState — the three technician-facing labels (PR-066) plus conflict', () => {
  beforeEach(async () => {
    await db.jobs.put({
      id: 'job-1',
      job: makeJob(),
      cachedAt: new Date().toISOString(),
      hasPendingOutbox: false,
      submitState: 'none',
      serverRemoved: false,
      predictedDraftVersion: 1,
    });
  });

  it('reports held-on-device for a cached job with no edits yet and no outbox rows (not submitted)', async () => {
    // "received by server" is reserved for a job that has actually been
    // submitted — a job with everything synced but Submit never tapped is
    // still, correctly, "held on device".
    expect(await jobSyncState(db, 'job-1')).toBe('held-on-device');
  });

  it('still reports held-on-device once a mutation is queued AND then acknowledged, as long as submit was never called (the diagram\'s SYNCED state)', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    await drain(db, transport); // outbox is now empty — but nothing was ever submitted
    expect(await pendingCountForJob(db, 'job-1')).toBe(0);
    expect(await jobSyncState(db, 'job-1')).toBe('held-on-device');
  });

  it('reports held-on-device once a mutation is queued', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    expect(await jobSyncState(db, 'job-1')).toBe('held-on-device');
  });

  it('reports conflict when a retained mutation needs the technician to choose', async () => {
    const { entry } = (await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    })) as { ok: true; entry: { id: string } };
    const transport = new MockSyncTransport();
    transport.forceConflict(entry.id);
    await drain(db, transport);
    expect(await jobSyncState(db, 'job-1')).toBe('conflict');
  });

  it('reports sending while a batch is in flight (row marked "sending")', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const rows = await db.outbox.toArray();
    await db.outbox.put({ ...rows[0], status: 'sending' });
    expect(await jobSyncState(db, 'job-1')).toBe('sending');
  });

  it('reports sending while submit itself is in flight', async () => {
    const job = await db.jobs.get('job-1');
    await db.jobs.put({ ...job!, submitState: 'submitting' });
    expect(await jobSyncState(db, 'job-1')).toBe('sending');
  });

  it('reports received-by-server once submitted', async () => {
    const job = await db.jobs.get('job-1');
    await db.jobs.put({ ...job!, submitState: 'submitted' });
    expect(await jobSyncState(db, 'job-1')).toBe('received-by-server');
  });
});

describe('watchOnlineAndDrain', () => {
  it('drains the outbox when the browser fires the online event, and unsubscribe stops it', async () => {
    await db.jobs.put({
      id: 'job-1',
      job: makeJob(),
      cachedAt: new Date().toISOString(),
      hasPendingOutbox: false,
      submitState: 'none',
      serverRemoved: false,
      predictedDraftVersion: 1,
    });
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    const seen: number[] = [];
    const unsubscribe = watchOnlineAndDrain(db, transport, (summaries) => {
      seen.push(summaries.reduce((n, s) => n + s.acked, 0));
    });

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(seen).toEqual([1]));

    unsubscribe();
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/y',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    window.dispatchEvent(new Event('online'));
    // give any (incorrect, post-unsubscribe) handler a tick to run
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([1]); // unchanged — unsubscribe worked
  });
});

describe('triggerDrainIfOnline', () => {
  it('drains immediately when the device currently reports online (the common case: entries made while connected)', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const seen: number[] = [];
    triggerDrainIfOnline(db, transport, (summaries) => seen.push(summaries.reduce((n, s) => n + s.acked, 0)));
    await vi.waitFor(() => expect(seen).toEqual([1]));
    expect(await pendingCountForJob(db, 'job-1')).toBe(0);
  });

  it('does nothing when the device reports offline — the entry stays durable, untouched, for the next real trigger', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const onDrain = vi.fn();
    triggerDrainIfOnline(db, transport, onDrain);
    await new Promise((r) => setTimeout(r, 10));
    expect(onDrain).not.toHaveBeenCalled();
    expect(await pendingCountForJob(db, 'job-1')).toBe(1);
  });

  it('swallows a drain failure rather than throwing out of a fire-and-forget call', async () => {
    await append(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/x',
      body: {},
      ifMatch: 1,
      clientRecordedAt: new Date().toISOString(),
    });
    const transport = new MockSyncTransport();
    transport.networkDown = true;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    expect(() => triggerDrainIfOnline(db, transport)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(await pendingCountForJob(db, 'job-1')).toBe(1); // still there, safely
  });
});

describe('appendJobMutation — predicted draftVersion avoids a self-inflicted conflict', () => {
  beforeEach(async () => {
    await db.jobs.put({
      id: 'job-1',
      job: makeJob({ draftVersion: 1 }),
      cachedAt: new Date().toISOString(),
      hasPendingOutbox: false,
      submitState: 'none',
      serverRemoved: false,
      predictedDraftVersion: 1,
    });
  });

  it('uses the cached job draftVersion as ifMatch for the first mutation', async () => {
    const result = await appendJobMutation(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/item-1',
      body: { status: 'DONE' },
      clientRecordedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry.ifMatch).toBe(1);
  });

  it('advances the predicted version so a SECOND queued mutation for the same job does not carry a stale ifMatch', async () => {
    const first = await appendJobMutation(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/item-1',
      body: { status: 'DONE' },
      clientRecordedAt: new Date().toISOString(),
    });
    const second = await appendJobMutation(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/item-2',
      body: { status: 'DONE' },
      clientRecordedAt: new Date().toISOString(),
    });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.entry.ifMatch).toBe(1);
    expect(second.entry.ifMatch).toBe(2); // NOT 1 again — see module doc

    // Proves the point end to end: a server that increments its real
    // draftVersion by one per applied mutation accepts BOTH, because each
    // carried the version it will actually be at, not a shared stale one.
    const transport = new MockSyncTransport();
    const summary = await drain(db, transport);
    expect(summary.acked).toBe(2);
    expect(summary.conflicted).toBe(0);
  });

  it('does not advance the predicted version when the write is refused (quota exceeded)', async () => {
    const original = db.outbox.add.bind(db.outbox);
    db.outbox.add = (() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }) as typeof db.outbox.add;

    const result = await appendJobMutation(db, {
      jobId: 'job-1',
      method: 'PUT',
      path: '/jobs/job-1/items/item-1',
      body: { status: 'DONE' },
      clientRecordedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    const job = await getCachedJob(db, 'job-1');
    expect(job?.predictedDraftVersion).toBe(1); // unchanged

    db.outbox.add = original;
  });

  it('is a safe no-op guard for a job not present in the local cache (ifMatch simply null)', async () => {
    const result = await appendJobMutation(db, {
      jobId: 'ghost-job',
      method: 'PUT',
      path: '/jobs/ghost-job/items/item-1',
      body: { status: 'DONE' },
      clientRecordedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.entry.ifMatch).toBeNull();
  });
});
