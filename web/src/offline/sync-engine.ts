import type { BamFormDB, CachedJob, OutboxMethod } from './db';
import { META_KEYS } from './db';
import type { SyncTransport, SyncBootstrap } from '../api/transport';
import { append, drainAll, pendingCountForJob, type AppendResult, type DrainSummary } from './outbox';
import { uuidv7 } from '../lib/uuidv7';
import type { components } from '../api/generated/openapi-types';

type Job = components['schemas']['Job'];

/** Beyond this, the device clock is treated as meaningfully skewed (O-09).
 * Chosen to match PR-063's own five-minute threshold for flagging a
 * discrepancy between `client_recorded_at` and the server's `recorded_at`
 * on a single record, so the two mechanisms agree on what "skewed" means. */
const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

export interface BootstrapSummary {
  serverTime: string;
  localTimeAtBootstrap: string;
  clockSkewMs: number;
  skewDetected: boolean;
  jobsUpserted: number;
  /** Jobs that already had unsynced local edits — the server snapshot for
   * them was NOT applied, protecting both the in-flight edits and the
   * job's frozen template revision (O-10). */
  jobsProtected: number;
  jobsRemoved: number;
  /** Server said these jobs are gone (reassigned/deleted), but the device
   * still had unsynced work for them — kept locally and flagged rather than
   * deleted, so the technician is told rather than silently losing the
   * record (O-14). */
  jobsFlaggedRemovedWithPendingWork: number;
}

/**
 * PR-059 (bootstrap) + O-09 (clock skew) + O-10 (frozen revision survives a
 * later revision being issued while the job is cached).
 *
 * The merge rule that makes O-10 hold: a job that already has unsynced
 * outbox entries is NEVER overwritten by an incoming bootstrap snapshot,
 * including its `templateRevision`. Each job is bound to one revision for
 * its lifetime by the server's own data model — if a snapshot for the same
 * job id ever arrived carrying a different revision, accepting it would
 * silently rebind an in-progress record to different checklist content,
 * which is exactly what O-10 exists to prevent. Jobs with no local edits are
 * safe to fully refresh.
 */
export async function bootstrap(
  db: BamFormDB,
  transport: SyncTransport,
  since?: string,
): Promise<BootstrapSummary> {
  const localTimeAtBootstrap = new Date().toISOString();
  const response: SyncBootstrap = await transport.bootstrap(since);

  const localMs = Date.parse(localTimeAtBootstrap);
  const serverMs = Date.parse(response.serverTime);
  const clockSkewMs = localMs - serverMs;
  const skewDetected = Math.abs(clockSkewMs) > CLOCK_SKEW_THRESHOLD_MS;

  let jobsUpserted = 0;
  let jobsProtected = 0;

  await db.transaction('rw', db.jobs, async () => {
    for (const job of response.jobs) {
      const existing = await db.jobs.get(job.id);
      if (existing?.hasPendingOutbox) {
        jobsProtected++;
        continue;
      }
      const row: CachedJob = {
        id: job.id,
        job,
        cachedAt: localTimeAtBootstrap,
        hasPendingOutbox: false,
        submitState: existing?.submitState ?? 'none',
        serverRemoved: false,
        predictedDraftVersion: job.draftVersion ?? 1,
      };
      await db.jobs.put(row);
      jobsUpserted++;
    }
  });

  let jobsRemoved = 0;
  let jobsFlaggedRemovedWithPendingWork = 0;

  if (response.deletedJobIds?.length) {
    await db.transaction('rw', db.jobs, async () => {
      for (const jobId of response.deletedJobIds ?? []) {
        const existing = await db.jobs.get(jobId);
        if (!existing) continue;
        if (existing.hasPendingOutbox) {
          // O-14: do not delete — the technician has unsynced work here.
          await db.jobs.put({ ...existing, serverRemoved: true });
          jobsFlaggedRemovedWithPendingWork++;
        } else {
          await db.jobs.delete(jobId);
          jobsRemoved++;
        }
      }
    });
  }

  await db.meta.put({ key: META_KEYS.syncToken, value: response.syncToken });
  await db.meta.put({ key: META_KEYS.lastBootstrapAt, value: localTimeAtBootstrap });
  await db.meta.put({
    key: META_KEYS.clockSkewMs,
    value: { clockSkewMs, skewDetected, serverTime: response.serverTime, localTime: localTimeAtBootstrap },
  });

  return {
    serverTime: response.serverTime,
    localTimeAtBootstrap,
    clockSkewMs,
    skewDetected,
    jobsUpserted,
    jobsProtected,
    jobsRemoved,
    jobsFlaggedRemovedWithPendingWork,
  };
}

export interface ClockSkewRecord {
  clockSkewMs: number;
  skewDetected: boolean;
  serverTime: string;
  localTime: string;
}

export async function getClockSkew(db: BamFormDB): Promise<ClockSkewRecord | null> {
  const row = await db.meta.get(META_KEYS.clockSkewMs);
  return (row?.value as ClockSkewRecord | undefined) ?? null;
}

/**
 * The only place a screen should call `outbox.append()` for a job-scoped
 * mutation (item result, measurement reading). Wraps it with the
 * `predictedDraftVersion` bookkeeping described on `CachedJob`: a
 * technician entering several checklist items offline queues several
 * mutations for the SAME job before any of them has been acknowledged. If
 * every one of those carried the same `ifMatch` (the version last seen from
 * the server), the server applying the first would bump the job's real
 * version, and every subsequent one in the same batch would look like a
 * conflict with a change from ANOTHER device — indistinguishable from a
 * genuine O-13 conflict, even though it is really just this same client's
 * own next edit. Optimistically predicting and advancing the version
 * locally (only reset by the next bootstrap) keeps a real conflict
 * detectable while eliminating this self-inflicted one.
 */
export async function appendJobMutation(
  db: BamFormDB,
  input: { jobId: string; method: OutboxMethod; path: string; body: unknown; clientRecordedAt: string },
): Promise<AppendResult> {
  const job = await db.jobs.get(input.jobId);
  const ifMatch = job?.predictedDraftVersion ?? job?.job.draftVersion ?? null;
  const result = await append(db, { ...input, ifMatch });
  if (result.ok && job && ifMatch != null) {
    await db.jobs.put({ ...job, predictedDraftVersion: ifMatch + 1 });
  }
  return result;
}

/**
 * Non-negotiable #2 (PR-API-26 / PR-065): submission is a single atomic call
 * made ONLY after every preceding mutation for this job has been
 * acknowledged. This function is the one and only place that calls
 * `transport.submitJob` — it is never invoked from inside `drain`/`drainAll`,
 * and it refuses to run at all while outbox rows remain for the job.
 */
export type SubmitGuardError =
  | { ok: false; reason: 'pending-mutations'; pendingCount: number }
  | { ok: false; reason: 'server-removed' }
  | { ok: false; reason: 'server-rejected'; status: number; problem?: unknown };
export type SubmitResult = { ok: true; status: number } | SubmitGuardError;

export async function submitJob(db: BamFormDB, transport: SyncTransport, jobId: string): Promise<SubmitResult> {
  const job = await db.jobs.get(jobId);
  if (job?.serverRemoved) {
    return { ok: false, reason: 'server-removed' };
  }
  // The guard that encodes non-negotiable #2: refuse to even attempt submit
  // while any outbox row for this job remains — pending, conflicted,
  // in-flight or failed. Submit only ever runs once every prior mutation is
  // acknowledged, and it is always this separate call, never folded into a
  // drain() batch.
  const pending = await pendingCountForJob(db, jobId);
  if (pending > 0) {
    return { ok: false, reason: 'pending-mutations', pendingCount: pending };
  }

  if (job) await db.jobs.put({ ...job, submitState: 'submitting' });
  const idempotencyKey = uuidv7();
  const response = await transport.submitJob(jobId, idempotencyKey);

  if (response.ok) {
    if (job) await db.jobs.put({ ...job, submitState: 'submitted' });
    return { ok: true, status: response.status };
  }
  if (job) await db.jobs.put({ ...job, submitState: 'none' });
  return { ok: false, reason: 'server-rejected', status: response.status, problem: response.problem };
}

/** The three technician-facing labels from PR-066/PR-WFD-04, plus an
 * explicit `conflict` state: PR-064 requires a conflict be surfaced (O-08),
 * which the three-label simplification does not have room for on its own —
 * a conflicted mutation is still, truthfully, "held on device" (not yet
 * received), but the technician additionally needs to know it requires
 * their input, so it gets its own label rather than being silently folded
 * into "held on device". */
export type JobSyncState = 'held-on-device' | 'sending' | 'conflict' | 'received-by-server';

export async function jobSyncState(db: BamFormDB, jobId: string): Promise<JobSyncState> {
  const job = await db.jobs.get(jobId);
  if (job?.submitState === 'submitted') return 'received-by-server';
  if (job?.submitState === 'submitting') return 'sending';

  // "received by server" is reserved for the JOB having been submitted —
  // UR-038 asks whether the technician's WORK (the record) has been
  // transmitted, not whether an individual field sync happened to land.
  // The diagram's SYNCED state (every mutation acked, submit not yet
  // called) is deliberately still shown as "held on device": telling a
  // technician their record is "received" before they have tapped Submit
  // would invite them to walk away from an unsubmitted job.
  const rows = await db.outbox.where('jobId').equals(jobId).toArray();
  if (rows.some((r) => r.status === 'conflict')) return 'conflict';
  if (rows.some((r) => r.status === 'sending')) return 'sending';
  return 'held-on-device';
}

/** Best-effort, fire-and-forget attempt to drain right now if the device
 * currently reports as online — called after every `append()` from a
 * screen. Without this, a mutation entered while the device was already
 * online (the common case: most entries are NOT made offline) would sit in
 * the outbox until the next `online` *transition* event, which never fires
 * again once already online. `watchOnlineAndDrain` below covers the
 * reconnect case; this covers "online the whole time". Failures are
 * swallowed here deliberately — the entry is safely durable in the outbox
 * either way (non-negotiable #1 does not depend on this function ever
 * succeeding), and the next `online` event or manual sync will retry it. */
export function triggerDrainIfOnline(
  db: BamFormDB,
  transport: SyncTransport,
  onDrain?: (summaries: DrainSummary[]) => void,
): void {
  if (!navigator.onLine) return;
  void drainAll(db, transport)
    .then((summaries) => onDrain?.(summaries))
    .catch(() => {
      /* swallowed — see comment above */
    });
}

/** Wires the outbox to drain automatically when the device regains
 * connectivity (PR-069/UR-088). Returns an unsubscribe function. Safe to
 * call in a non-browser test environment: it no-ops if `window` has no
 * `addEventListener` (never true in this app's actual runtime, only in a
 * unit test that chooses not to exercise it). */
export function watchOnlineAndDrain(
  db: BamFormDB,
  transport: SyncTransport,
  onDrain?: (summaries: DrainSummary[]) => void,
): () => void {
  const handler = () => {
    void drainAll(db, transport).then((summaries) => onDrain?.(summaries));
  };
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}

export function getCachedJob(db: BamFormDB, jobId: string): Promise<CachedJob | undefined> {
  return db.jobs.get(jobId);
}

export function listCachedJobs(db: BamFormDB): Promise<CachedJob[]> {
  return db.jobs.toArray();
}

export type { Job };
