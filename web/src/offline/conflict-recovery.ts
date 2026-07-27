import type { BamFormDB } from './db';
import type { SyncTransport, Job } from '../api/transport';
import { drainAll, retryConflictWithNewId } from './outbox';

/**
 * SYS-5: the code-level recovery the conflict UI calls. Before this slice,
 * `retryConflictWithNewId`/`discardConflict` existed and were tested but had
 * ZERO callers in any screen — one 409 wedged the device forever (Submit is
 * guarded on an empty outbox, conflict rows are excluded from every drain,
 * and the only recovery was devtools IndexedDB surgery).
 *
 * This module composes the EXISTING primitives into the two recoveries
 * PR-064 describes, without inventing new sync semantics:
 *
 *  - `keep-mine`  — "the technician keeps their value": every retained row
 *    is re-queued via `retryConflictWithNewId`, with `ifMatch` refreshed
 *    from the server's CURRENT draftVersion (the review's exact
 *    prescription — replaying the stale one would 409 forever) and chained
 *    +1 per row exactly as `appendJobMutation` predicts versions.
 *  - `accept-server` — "the technician takes the server's value": retained
 *    rows are discarded and the cached job is refetched, so the device's
 *    copy IS the server truth again (a per-job re-bootstrap).
 *
 * Both require connectivity: recovery is meaningless without the server's
 * current state, and the UI says so rather than pretending.
 */
export type ConflictRecoveryChoice = 'keep-mine' | 'accept-server';

export type ConflictRecoveryResult =
  | { ok: true; action: 'kept-mine' | 'accepted-server'; retried: number; discarded: number }
  | { ok: false; reason: 'offline' };

export async function recoverJobConflicts(
  db: BamFormDB,
  transport: SyncTransport,
  userId: string,
  jobId: string,
  choice: ConflictRecoveryChoice,
): Promise<ConflictRecoveryResult> {
  // 1. Flush anything still genuinely sendable, so the rebuild below acts
  // on a settled set. Retries here reuse their ORIGINAL ids (safe against
  // the O-15 ambiguity — an already-applied row replays as a no-op).
  const flush = await drainAll(db, transport, userId);
  if (flush.some((s) => s.networkError)) return { ok: false, reason: 'offline' };

  // 2. The server's current truth for this job — draftVersion AND state.
  // GET /jobs/{id} authorises per-call server-side; nothing here decides
  // permission (non-negotiable #6).
  let serverJob: Job;
  try {
    serverJob = await transport.getJob(jobId);
  } catch {
    return { ok: false, reason: 'offline' };
  }
  const serverVersion = serverJob.draftVersion ?? 1;

  let retried = 0;
  let discarded = 0;

  await db.transaction('rw', db.outbox, db.jobs, async () => {
    const rows = await db.outbox.where('[userId+jobId]').equals([userId, jobId]).sortBy('sequence');
    const retained = rows.filter((r) => r.status === 'conflict' || r.status === 'failed');

    if (choice === 'accept-server') {
      for (const row of retained) {
        await db.outbox.delete(row.id);
        discarded++;
      }
    } else {
      // keep-mine: re-queue each retained row in sequence order with the
      // corrected version chain — first row carries the server's current
      // version, each subsequent versioned row one higher (mirroring the
      // server's +1-per-applied-mutation bump, the same prediction rule
      // `appendJobMutation` uses).
      let offset = 0;
      for (const row of retained) {
        const ifMatch = row.ifMatch == null ? null : serverVersion + offset;
        if (row.ifMatch != null) offset++;
        await retryConflictWithNewId(db, row.id, { ifMatch });
        retried++;
      }
    }

    // 3. Re-baseline the cached job on the refetched server snapshot. Safe
    // with respect to O-10: a job is bound to ONE template revision for its
    // lifetime by the server's own data model (PR-048/049), so this
    // snapshot carries the same frozen revision the device already holds.
    const remaining = await db.outbox.where('[userId+jobId]').equals([userId, jobId]).toArray();
    const versionedRemaining = remaining.filter((r) => r.ifMatch != null).length;
    const cached = await db.jobs.get([userId, jobId]);
    await db.jobs.put({
      userId,
      id: jobId,
      job: serverJob,
      cachedAt: new Date().toISOString(),
      hasPendingOutbox: remaining.length > 0,
      submitState: cached?.submitState ?? 'none',
      serverRemoved: false,
      predictedDraftVersion: serverVersion + versionedRemaining,
      submitIdempotencyKey: cached?.submitIdempotencyKey ?? null,
    });
  });

  if (choice === 'keep-mine') {
    // 4. Best-effort immediate resend — failures leave the rows safely
    // pending for the next drain trigger; durability never depends on this.
    await drainAll(db, transport, userId);
    return { ok: true, action: 'kept-mine', retried, discarded: 0 };
  }
  return { ok: true, action: 'accepted-server', retried: 0, discarded };
}
