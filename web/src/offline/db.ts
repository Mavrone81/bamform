import Dexie, { type Table } from 'dexie';
import type { components } from '../api/generated/openapi-types';

type Job = components['schemas']['Job'];

/** HTTP verbs the offline outbox is allowed to replay (matches OutboxMutation
 * in api/openapi.yaml — DELETE is in the contract's enum but BUILD_HANDOFF
 * §4.7 forbids DELETE on any record table server-side, so the client never
 * constructs one; kept in the type union only to stay contract-shaped). */
export type OutboxMethod = 'PUT' | 'POST' | 'DELETE';

export type OutboxEntryStatus =
  /** Queued, never yet sent. */
  | 'pending'
  /** A drain request carrying this entry is in flight. */
  | 'sending'
  /** Server returned 409 — retained per PR-064, awaiting technician choice. */
  | 'conflict'
  /** Sent, server rejected for a reason other than 409/replay (e.g. 422) and
   * it is not safe to silently retry without a caller decision. Still
   * retained — never cleared without an `applied: true` ack (non-negotiable
   * #1). */
  | 'failed';

/**
 * One durable outbox row = one offline mutation. `id` is a client-generated
 * UUIDv7 (ADR-008) and is sent as the `Idempotency-Key` header verbatim —
 * it is never regenerated once written.
 *
 * PR-WFD-05 / non-negotiable #1: a row is deleted from this table ONLY when
 * the server has acknowledged (`OutboxResult.applied === true`) the mutation
 * carrying this exact id. See offline/outbox.ts `drain()`.
 */
export interface OutboxEntry {
  /** UUIDv7. Primary key. Doubles as Idempotency-Key. */
  id: string;
  /** Device-monotonic, auto-incrementing. Defines send order (PR-061). */
  sequence: number;
  jobId: string;
  method: OutboxMethod;
  /** Path relative to VITE_API_BASE_URL, e.g. `/jobs/{id}/items/{itemId}`. */
  path: string;
  body: unknown;
  /** draftVersion this mutation was based on — sent as `If-Match`. */
  ifMatch: number | null;
  /** When the technician actually performed the action (PR-063). */
  clientRecordedAt: string;
  /** When this row was appended to the outbox (diagnostics only). */
  createdAt: string;
  status: OutboxEntryStatus;
  attempts: number;
  lastError: string | null;
  /** Present once the server has responded at all (ack or reject). */
  lastResult: { status: number; problem: unknown } | null;
}

/** A locally cached job. Mirrors the server `Job` shape (bootstrap payload)
 * plus a `hasPendingOutbox` convenience flag maintained by the outbox module
 * so screens don't need to join against the outbox table to show sync state. */
export interface CachedJob {
  id: string;
  job: Job;
  cachedAt: string;
  /** Local edits not yet reflected on the server — used to decide whether a
   * later bootstrap is allowed to overwrite this row (see mergeBootstrapJobs
   * in sync-engine.ts — O-10 frozen-revision protection). */
  hasPendingOutbox: boolean;
  submitState: 'none' | 'submitting' | 'submitted';
  /** Set when a bootstrap reports this job as removed/reassigned server-side
   * (O-14) while it still had local unsynced work. The job is kept — never
   * silently deleted, since that would drop a technician's local edits —
   * but flagged so the UI can tell them and block submit. */
  serverRemoved: boolean;
  /** The draftVersion the NEXT mutation for this job should use as
   * `If-Match`. Starts equal to `job.draftVersion` from the last bootstrap,
   * and is optimistically advanced by one every time a mutation for this
   * job is appended (see offline/sync-engine.ts `appendJobMutation`) —
   * without this, two offline edits to the SAME job would both carry the
   * same stale `ifMatch`, and the server applying the first would make the
   * second look like a conflict with a DIFFERENT device's edit when it is
   * really just the client's own next change in sequence. */
  predictedDraftVersion: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export const META_KEYS = {
  syncToken: 'syncToken',
  clockSkewMs: 'clockSkewMs',
  lastBootstrapAt: 'lastBootstrapAt',
  quotaWarning: 'quotaWarning',
} as const;

/**
 * A row can only be `sending` while a `drain()` call has claimed it and is
 * waiting on the network — see outbox.ts's atomic claim-then-send
 * transaction. If the browser/tab dies in that exact window (claim
 * committed, `fetch` never settles — no thrown error, no response, nothing
 * for `drain()`'s own catch block to ever run), the row is left `sending`
 * FOREVER: `listDrainable` deliberately excludes `sending` rows (it is the
 * concurrency lock — see outbox.ts's `drain()` doc), and nothing else ever
 * moves it back to `pending`. That is a real record-stranding hole in the
 * RK-01 guarantee, worse than O-03 (which waits for the network-error catch
 * to fire first, so the row does reach `pending` before the tab dies).
 *
 * A `sending` row still present when a `BamFormDB` is newly opened can only
 * mean the PREVIOUS session that claimed it is gone — nothing in the
 * current session has claimed anything yet. It is always safe to hand it
 * back to `pending`: its id is still the same client-generated UUIDv7
 * (ADR-008), so if that previous session's request actually reached and
 * was applied by the server before dying, the replay is a safe no-op
 * (PR-062's idempotency store) — never a double-apply (O-05).
 */
export async function recoverStuckSendingRows(db: BamFormDB): Promise<void> {
  const stuck = await db.outbox.where('status').equals('sending').toArray();
  if (stuck.length === 0) return;
  await db.outbox.bulkPut(stuck.map((row) => ({ ...row, status: 'pending' as const })));
}

export class BamFormDB extends Dexie {
  outbox!: Table<OutboxEntry, string>;
  jobs!: Table<CachedJob, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'bamform-offline') {
    super(name);
    this.version(1).stores({
      // `sequence` is assigned by outbox.ts from a monotonic counter kept in
      // `meta` (incremented inside the same transaction as the insert), so
      // it stays strictly increasing and never reused even as acked rows
      // are deleted — the outbox drains in this order (PR-061), not by
      // wall-clock `createdAt`, which is not guaranteed monotonic across a
      // clock adjustment.
      outbox: 'id, sequence, jobId, status, [jobId+status]',
      jobs: 'id, submitState',
      meta: 'key',
    });

    // Dexie queues every other operation issued against this instance
    // until its `ready` handler's returned promise resolves — so this
    // recovery is guaranteed to run and complete before the first
    // `drain()` (or anything else) touches the outbox table, no matter
    // which code path triggers that first drain (app-startup bootstrap,
    // the `online` listener, or a manual sync tap racing it).
    this.on('ready', () => recoverStuckSendingRows(this));
  }
}

let singleton: BamFormDB | null = null;

/** The app should call this once; tests construct their own named instances
 * so parallel test files never share IndexedDB state. */
export function getDB(): BamFormDB {
  if (!singleton) singleton = new BamFormDB();
  return singleton;
}

export function createTestDB(name: string): BamFormDB {
  return new BamFormDB(name);
}
