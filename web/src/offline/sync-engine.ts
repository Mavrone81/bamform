import type { BamFormDB, CachedJob, OutboxMethod } from './db';
import { META_KEYS, claimLegacyRows, userMetaKey } from './db';
import type { SyncTransport, SyncBootstrap } from '../api/transport';
import {
  append,
  drainAll,
  pendingCountForJob,
  type AppendResult,
  type DrainSummary,
} from './outbox';
import { uuidv7 } from '../lib/uuidv7';
import type { components } from '../api/generated/openapi-types';

type Job = components['schemas']['Job'];

/** Beyond this, the device clock is treated as meaningfully skewed (O-09).
 * Chosen to match PR-063's own five-minute threshold for flagging a
 * discrepancy between `client_recorded_at` and the server's `recorded_at`
 * on a single record, so the two mechanisms agree on what "skewed" means. */
const CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

export interface BootstrapSummary {
  /** The id the SERVER says this bootstrap belongs to — every row this
   * bootstrap wrote is keyed under it (SYS-6). */
  userId: string;
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
 * SYS-6: every row written here is keyed by `response.user.id` — the
 * identity the SERVER attached to this authenticated response, never a
 * client-side claim. This is also the single place legacy (pre-partition)
 * rows are claimed: the first server-confirmed principal after the v1→v2
 * upgrade takes ownership of the device's unclaimed work (see
 * `claimLegacyRows` for why that is the honest choice).
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
  const userId = response.user.id;

  await claimLegacyRows(db, userId);

  const localMs = Date.parse(localTimeAtBootstrap);
  const serverMs = Date.parse(response.serverTime);
  const clockSkewMs = localMs - serverMs;
  const skewDetected = Math.abs(clockSkewMs) > CLOCK_SKEW_THRESHOLD_MS;

  let jobsUpserted = 0;
  let jobsProtected = 0;

  await db.transaction('rw', db.jobs, async () => {
    for (const job of response.jobs) {
      const existing = await db.jobs.get([userId, job.id]);
      if (existing?.hasPendingOutbox) {
        jobsProtected++;
        continue;
      }
      const row: CachedJob = {
        userId,
        id: job.id,
        job,
        cachedAt: localTimeAtBootstrap,
        hasPendingOutbox: false,
        submitState: existing?.submitState ?? 'none',
        serverRemoved: false,
        predictedDraftVersion: job.draftVersion ?? 1,
        submitIdempotencyKey: existing?.submitIdempotencyKey ?? null,
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
        const existing = await db.jobs.get([userId, jobId]);
        if (!existing) continue;
        if (existing.hasPendingOutbox) {
          // O-14: do not delete — the technician has unsynced work here.
          await db.jobs.put({ ...existing, serverRemoved: true });
          jobsFlaggedRemovedWithPendingWork++;
        } else {
          await db.jobs.delete([userId, jobId]);
          jobsRemoved++;
        }
      }
    });
  }

  await db.meta.put({ key: userMetaKey(userId, META_KEYS.syncToken), value: response.syncToken });
  await db.meta.put({
    key: userMetaKey(userId, META_KEYS.lastBootstrapAt),
    value: localTimeAtBootstrap,
  });
  // Clock skew is a fact about the DEVICE, not the signed-in user — kept
  // un-namespaced so the banner logic is identical whoever signs in.
  await db.meta.put({
    key: META_KEYS.clockSkewMs,
    value: {
      clockSkewMs,
      skewDetected,
      serverTime: response.serverTime,
      localTime: localTimeAtBootstrap,
    },
  });

  return {
    userId,
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
  input: {
    /** Server-returned id of the signed-in principal (SYS-6). */
    userId: string;
    jobId: string;
    method: OutboxMethod;
    path: string;
    body: unknown;
    clientRecordedAt: string;
  },
): Promise<AppendResult> {
  const job = await db.jobs.get([input.userId, input.jobId]);
  const ifMatch = job?.predictedDraftVersion ?? job?.job.draftVersion ?? null;
  const result = await append(db, { ...input, ifMatch });
  if (result.ok && ifMatch != null) {
    // Re-fetch rather than reuse `job`: `append()` above already wrote its
    // own update to this same row (setting `hasPendingOutbox: true`) in a
    // separate transaction. Merging into the pre-append copy captured
    // above would silently undo that — a real bug caught by O-10's E2E
    // test, not by the unit suite (which only asserted ifMatch/version
    // values, not this specific read-modify-write race).
    const fresh = await db.jobs.get([input.userId, input.jobId]);
    if (fresh) await db.jobs.put({ ...fresh, predictedDraftVersion: ifMatch + 1 });
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
  /** SYS-14: the request never completed — no response reached this device.
   * The job is still safely unsubmitted locally (or submitted server-side
   * with the SAME persisted idempotency key, in which case the retry
   * replays as a no-op success). Retryable, and the UI must say so instead
   * of blaming the record's content. */
  | { ok: false; reason: 'network' }
  /** The server answered and refused. `status` tells retryable apart from
   * not: 409 = the job is not in a submittable state (re-check reality),
   * 422 = the record's content was rejected. */
  | { ok: false; reason: 'server-rejected'; status: number; problem?: unknown };
export type SubmitResult = { ok: true; status: number } | SubmitGuardError;

/**
 * Slice 18-WORKFLOW: `drawnSignature` (the PERFORMER's, a base64 PNG
 * data-URL from `SignaturePad`) is REQUIRED and rides this one call. The pad
 * itself works offline — it is a `<canvas>`, no network — and submit stays
 * exactly what non-negotiable #2 makes it: a separate, atomic, never-batched
 * request that refuses to run while any outbox row for the job remains. The
 * signature is held in memory for the duration of the call only; it is never
 * written to IndexedDB (an unsent record's signature would be a personal-data
 * blob sitting unencrypted in browser storage) — which means a submission
 * attempted offline is re-signed on the retry, by the same person, in front
 * of the same record.
 */
export async function submitJob(
  db: BamFormDB,
  transport: SyncTransport,
  userId: string,
  jobId: string,
  drawnSignature: string,
): Promise<SubmitResult> {
  const job = await db.jobs.get([userId, jobId]);
  if (job?.serverRemoved) {
    return { ok: false, reason: 'server-removed' };
  }
  // The guard that encodes non-negotiable #2: refuse to even attempt submit
  // while any outbox row for this job remains — pending, conflicted,
  // in-flight or failed. Submit only ever runs once every prior mutation is
  // acknowledged, and it is always this separate call, never folded into a
  // drain() batch.
  const pending = await pendingCountForJob(db, userId, jobId);
  if (pending > 0) {
    return { ok: false, reason: 'pending-mutations', pendingCount: pending };
  }

  // SYS-14: reuse the persisted key from an earlier attempt whose response
  // was lost, so the retry REPLAYS that attempt (PR-062) instead of
  // colliding with it; persist BEFORE the request so a crash between send
  // and response still leaves the key on the row.
  const idempotencyKey = job?.submitIdempotencyKey ?? uuidv7();
  if (job) {
    await db.jobs.put({ ...job, submitState: 'submitting', submitIdempotencyKey: idempotencyKey });
  }

  let response: Awaited<ReturnType<SyncTransport['submitJob']>>;
  try {
    response = await transport.submitJob(jobId, idempotencyKey, { drawnSignature });
  } catch {
    // SYS-14: a transport throw is NOT a rejection of the record — no
    // response reached us. Reset the visible state (the chip must not say
    // "Sending" forever) but KEEP the idempotency key for the retry.
    const fresh = await db.jobs.get([userId, jobId]);
    if (fresh) await db.jobs.put({ ...fresh, submitState: 'none' });
    return { ok: false, reason: 'network' };
  }

  if (response.ok) {
    const fresh = await db.jobs.get([userId, jobId]);
    if (fresh) {
      await db.jobs.put({ ...fresh, submitState: 'submitted', submitIdempotencyKey: null });
    }
    return { ok: true, status: response.status };
  }
  // An explicit rejection DID reach us — there is no lost-response ambiguity
  // left to protect, so drop the key: if the technician fixes the record and
  // submits again, that is a genuinely new request and must not risk
  // replaying a stored rejection.
  const fresh = await db.jobs.get([userId, jobId]);
  if (fresh) await db.jobs.put({ ...fresh, submitState: 'none', submitIdempotencyKey: null });
  return {
    ok: false,
    reason: 'server-rejected',
    status: response.status,
    problem: response.problem,
  };
}

/** The three technician-facing labels from PR-066/PR-WFD-04, plus an
 * explicit `conflict` state: PR-064 requires a conflict be surfaced (O-08),
 * which the three-label simplification does not have room for on its own —
 * a conflicted mutation is still, truthfully, "held on device" (not yet
 * received), but the technician additionally needs to know it requires
 * their input, so it gets its own label rather than being silently folded
 * into "held on device". */
export type JobSyncState = 'held-on-device' | 'sending' | 'conflict' | 'received-by-server';

export async function jobSyncState(
  db: BamFormDB,
  userId: string,
  jobId: string,
): Promise<JobSyncState> {
  const job = await db.jobs.get([userId, jobId]);
  if (job?.submitState === 'submitted') return 'received-by-server';
  if (job?.submitState === 'submitting') return 'sending';

  // "received by server" is reserved for the JOB having been submitted —
  // UR-038 asks whether the technician's WORK (the record) has been
  // transmitted, not whether an individual field sync happened to land.
  // The diagram's SYNCED state (every mutation acked, submit not yet
  // called) is deliberately still shown as "held on device": telling a
  // technician their record is "received" before they have tapped Submit
  // would invite them to walk away from an unsubmitted job.
  const rows = await db.outbox.where('[userId+jobId]').equals([userId, jobId]).toArray();
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
 * succeeding), and the next `online` event or manual sync will retry it.
 *
 * SYS-6: `getUserId` is read AT DRAIN TIME (not captured once) so the drain
 * always sends the CURRENT principal's rows under the CURRENT bearer —
 * both come from the same server-returned session state. A null id (signed
 * out) drains nothing. */
export function triggerDrainIfOnline(
  db: BamFormDB,
  transport: SyncTransport,
  getUserId: () => string | null,
  onDrain?: (summaries: DrainSummary[]) => void,
): void {
  if (!navigator.onLine) return;
  const userId = getUserId();
  if (!userId) return;
  void drainAll(db, transport, userId)
    .then((summaries) => onDrain?.(summaries))
    .catch(() => {
      /* swallowed — see comment above */
    });
}

/** Wires the outbox to drain automatically when the device regains
 * connectivity (PR-069/UR-088). Returns an unsubscribe function. Safe to
 * call in a non-browser test environment: it no-ops if `window` has no
 * `addEventListener` (never true in this app's actual runtime, only in a
 * unit test that chooses not to exercise it). Same SYS-6 rule as
 * `triggerDrainIfOnline`: the user id is resolved when the event fires. */
export function watchOnlineAndDrain(
  db: BamFormDB,
  transport: SyncTransport,
  getUserId: () => string | null,
  onDrain?: (summaries: DrainSummary[]) => void,
): () => void {
  const handler = () => {
    const userId = getUserId();
    if (!userId) return;
    void drainAll(db, transport, userId).then((summaries) => onDrain?.(summaries));
  };
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}

export function getCachedJob(
  db: BamFormDB,
  userId: string,
  jobId: string,
): Promise<CachedJob | undefined> {
  return db.jobs.get([userId, jobId]);
}

/** ONLY the signed-in principal's cached jobs (SYS-6): user B must never
 * see user A's job list on a shared tablet. */
export function listCachedJobs(db: BamFormDB, userId: string): Promise<CachedJob[]> {
  return db.jobs.where('userId').equals(userId).toArray();
}

export type { Job };
