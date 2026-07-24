import type { BamFormDB, OutboxEntry, OutboxMethod } from './db';
import { uuidv7 } from '../lib/uuidv7';
import type { SyncTransport, OutboxMutation } from '../api/transport';

/** Contract cap (api/openapi.yaml `/sync/outbox` `mutations.maxItems`) — O-16.
 * The client must never construct a batch larger than this; it is not
 * merely a server-side check to route around. */
export const MAX_BATCH_SIZE = 200;

export interface AppendInput {
  jobId: string;
  method: OutboxMethod;
  path: string;
  body: unknown;
  ifMatch: number | null;
  clientRecordedAt: string;
}

export type AppendResult =
  | { ok: true; entry: OutboxEntry }
  | { ok: false; reason: 'quota-exceeded'; error: unknown };

export function isQuotaExceeded(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === 'QuotaExceededError';
  }
  // Dexie re-throws as its own error subclass but preserves `.name`.
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'QuotaExceededError'
  );
}

async function nextSequence(db: BamFormDB): Promise<number> {
  // Runs inside the caller's transaction. A monotonic counter kept in `meta`
  // — NOT `outbox.count()` — because rows are deleted on ack, which would
  // let a naive count-based sequence go backwards or collide (PR-061
  // requires sequence to define send order for the outbox's lifetime, not
  // just its current contents).
  const key = 'outboxSequenceCounter';
  const row = await db.meta.get(key);
  const next = (typeof row?.value === 'number' ? row.value : 0) + 1;
  await db.meta.put({ key, value: next });
  return next;
}

/**
 * Appends one mutation to the durable outbox. Synchronous from the
 * technician's point of view (PR-060): this resolves as soon as the write
 * lands in IndexedDB, with no network involved.
 *
 * Non-negotiable #1's mirror image lives here too: this call must never
 * *pretend* to succeed. If IndexedDB refuses the write (device storage
 * quota exceeded — O-11), the transaction aborts atomically (Dexie/IDB
 * guarantee) and the caller gets an explicit `quota-exceeded` result rather
 * than a silently-dropped entry, so the UI can refuse to show "held on
 * device" for something that was not, in fact, held anywhere.
 */
export async function append(db: BamFormDB, input: AppendInput): Promise<AppendResult> {
  const id = uuidv7();
  const now = new Date().toISOString();
  try {
    const entry = await db.transaction('rw', db.outbox, db.meta, db.jobs, async () => {
      const sequence = await nextSequence(db);
      const row: OutboxEntry = {
        id,
        sequence,
        jobId: input.jobId,
        method: input.method,
        path: input.path,
        body: input.body,
        ifMatch: input.ifMatch,
        clientRecordedAt: input.clientRecordedAt,
        createdAt: now,
        status: 'pending',
        attempts: 0,
        lastError: null,
        lastResult: null,
      };
      await db.outbox.add(row);
      const job = await db.jobs.get(input.jobId);
      if (job) await db.jobs.put({ ...job, hasPendingOutbox: true });
      return row;
    });
    return { ok: true, entry };
  } catch (error) {
    if (isQuotaExceeded(error)) {
      return { ok: false, reason: 'quota-exceeded', error };
    }
    throw error;
  }
}

/** Rows eligible to be sent on the next drain — never includes `conflict`
 * rows, which are retained but require an explicit technician decision
 * (PR-064) before they can be resent. */
export async function listDrainable(db: BamFormDB, limit = MAX_BATCH_SIZE): Promise<OutboxEntry[]> {
  const rows = await db.outbox
    .where('status')
    .anyOf('pending', 'failed')
    .sortBy('sequence');
  return rows.slice(0, limit);
}

export async function pendingCountForJob(db: BamFormDB, jobId: string): Promise<number> {
  return db.outbox.where('jobId').equals(jobId).count();
}

export async function hasConflicts(db: BamFormDB, jobId: string): Promise<boolean> {
  const rows = await db.outbox.where({ jobId, status: 'conflict' }).count();
  return rows > 0;
}

async function refreshJobPendingFlag(db: BamFormDB, jobId: string): Promise<void> {
  const remaining = await pendingCountForJob(db, jobId);
  const job = await db.jobs.get(jobId);
  if (job) await db.jobs.put({ ...job, hasPendingOutbox: remaining > 0 });
}

export interface DrainSummary {
  attempted: number;
  acked: number;
  conflicted: number;
  failed: number;
  /** Set when the whole batch request could not complete (network down,
   * thrown before any response was received). Every attempted row is
   * guaranteed still `pending` in this case — nothing is cleared. */
  networkError: boolean;
}

/**
 * Drains up to `MAX_BATCH_SIZE` pending mutations in sequence order.
 *
 * THE INVARIANT THIS FUNCTION EXISTS TO PROTECT (non-negotiable #1 /
 * PR-WFD-05 / tested by O-15): a row is deleted from the outbox if and only
 * if the server's response for that exact id says `applied: true`. Every
 * other outcome — a thrown request, a missing id in the results array, a
 * non-2xx status, a 409 — leaves the row in the table for a later drain.
 * There is no code path that clears optimistically.
 */
export async function drain(db: BamFormDB, transport: SyncTransport): Promise<DrainSummary> {
  const batch = await listDrainable(db);
  if (batch.length === 0) {
    return { attempted: 0, acked: 0, conflicted: 0, failed: 0, networkError: false };
  }

  // Mark 'sending' first. This both prevents a second concurrent drain()
  // call (e.g. a manual "sync now" tap racing the `online` event handler)
  // from re-sending the same rows, and is itself reverted below if the
  // request never gets a response — it is a lock, not a step toward
  // clearing the row.
  await db.outbox.bulkPut(batch.map((row) => ({ ...row, status: 'sending' as const })));

  const mutations: OutboxMutation[] = batch.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    clientRecordedAt: row.clientRecordedAt,
    method: row.method,
    path: row.path,
    ifMatch: row.ifMatch,
    body: row.body as Record<string, unknown> | null | undefined,
  }));

  let response: Awaited<ReturnType<SyncTransport['drainOutbox']>>;
  try {
    response = await transport.drainOutbox(mutations);
  } catch (error) {
    // No response reached the client at all — this is exactly the O-15/O-05
    // scenario. We do not know whether the server applied any of these
    // mutations. We must NOT clear anything; we revert to 'pending' so the
    // next drain retries with the SAME ids, and the server's 30-day
    // idempotency store (PR-062) guarantees a retry cannot double-apply.
    await db.outbox.bulkPut(
      batch.map((row) => ({
        ...row,
        status: 'pending' as const,
        attempts: row.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })),
    );
    return {
      attempted: batch.length,
      acked: 0,
      conflicted: 0,
      failed: 0,
      networkError: true,
    };
  }

  const byId = new Map(response.results.map((r) => [r.id, r]));
  let acked = 0;
  let conflicted = 0;
  let failed = 0;
  const touchedJobs = new Set<string>();

  for (const row of batch) {
    const result = byId.get(row.id);
    touchedJobs.add(row.jobId);

    if (result?.applied === true) {
      // The ONLY path that removes a row from the outbox.
      await db.outbox.delete(row.id);
      acked++;
      continue;
    }

    if (result && result.status === 409) {
      await db.outbox.put({
        ...row,
        status: 'conflict',
        attempts: row.attempts + 1,
        lastResult: { status: result.status, problem: result.problem ?? null },
      });
      conflicted++;
      continue;
    }

    // Covers: an explicit non-409 rejection, AND the case where the server
    // response simply omitted this id (malformed/partial response) — absence
    // of an `applied: true` is treated as "not acknowledged", never as
    // success by default.
    await db.outbox.put({
      ...row,
      status: 'failed',
      attempts: row.attempts + 1,
      lastResult: result ? { status: result.status, problem: result.problem ?? null } : null,
      lastError: result ? null : 'missing from server response',
    });
    failed++;
  }

  for (const jobId of touchedJobs) {
    await refreshJobPendingFlag(db, jobId);
  }

  return { attempted: batch.length, acked, conflicted, failed, networkError: false };
}

/** Drains repeatedly until nothing drainable remains or a batch makes no
 * forward progress (e.g. every remaining row is a `failed` retry that just
 * failed again) — bounds the loop so a persistent server error can't spin
 * forever. Callers needing "handle > 200 queued mutations" (O-16 at scale)
 * get this for free: each iteration takes the next 200 in sequence order. */
export async function drainAll(
  db: BamFormDB,
  transport: SyncTransport,
  maxIterations = 25,
): Promise<DrainSummary[]> {
  const summaries: DrainSummary[] = [];
  for (let i = 0; i < maxIterations; i++) {
    const summary = await drain(db, transport);
    if (summary.attempted === 0) break;
    summaries.push(summary);
    if (summary.networkError) break; // no point hammering a dead network
    if (summary.acked === 0) break; // no forward progress this round
  }
  return summaries;
}

/** The technician chooses to keep their local value and resend it (PR-064:
 * "the client shall present both values and require the technician to
 * choose"). Turns a `conflict` row back into `pending` so the next drain
 * retries it — with a FRESH id, because the original id's idempotency
 * record on the server already resolved to the conflicting response and
 * must not be replayed as if it were the same request. */
export async function retryConflictWithNewId(db: BamFormDB, entryId: string): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(entryId);
    if (!row || row.status !== 'conflict') return;
    await db.outbox.delete(row.id);
    const newId = uuidv7();
    await db.outbox.add({
      ...row,
      id: newId,
      status: 'pending',
      lastResult: null,
      lastError: null,
    });
  });
}

/** The technician accepts the server's value and discards their local edit. */
export async function discardConflict(db: BamFormDB, entryId: string): Promise<void> {
  const row = await db.outbox.get(entryId);
  await db.outbox.delete(entryId);
  if (row) await refreshJobPendingFlag(db, row.jobId);
}
