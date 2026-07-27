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
  /**
   * SYS-6: the SERVER-RETURNED id of the user whose bearer this mutation
   * must be sent under, and whose identity the server will record as
   * `recordedBy`. Set from the authenticated principal the server itself
   * described (`AuthResult.user.id` / bootstrap `user.id`) — never from a
   * client-side claim (non-negotiable #6/#10 discipline applies to identity
   * too). Rows written before slice 16 carry `LEGACY_USER_ID` until
   * `claimLegacyRows` re-keys them.
   */
  userId: string;
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
  /** SYS-6: owner of this cached copy — same server-returned-id rule as
   * `OutboxEntry.userId`. Part of the compound primary key `[userId+id]`,
   * so two users of a shared tablet can each hold a copy of the same job
   * (e.g. across a reassignment) without either overwriting the other's
   * local edit state. */
  userId: string;
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
  /**
   * SYS-14: the Idempotency-Key of the FIRST submit attempt for this job,
   * persisted before the request is sent and reused verbatim on every retry
   * — so a submit that was applied server-side but whose response never
   * reached the device replays as the same request (server's PR-062 store
   * returns the original success) instead of colliding 409 with itself.
   * Cleared when the server acknowledges the submit. Optional because rows
   * written before slice 16 do not carry it.
   */
  submitIdempotencyKey?: string | null;
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
  /** SYS-15: outcome of the one-time `navigator.storage.persist()` request
   * — `{ requestedAt, persisted }`. Device-level, not per-user. */
  storagePersistence: 'storagePersistence',
} as const;

/** Namespaces a meta key per user (SYS-6): sync tokens and bootstrap
 * bookkeeping describe one principal's sync relationship with the server,
 * not the device. Device-level keys (sequence counter, clock skew, storage
 * persistence) stay un-namespaced. */
export function userMetaKey(userId: string, key: string): string {
  return `u:${userId}:${key}`;
}

/**
 * Owner stamped onto rows that existed before the per-user partition
 * (Dexie v1 → v2 upgrade, SYS-6). The device was single-user before this
 * slice, so these rows belong to exactly one human — but WHICH one is not
 * recorded anywhere client-side, and inventing an owner locally would be a
 * client-side identity claim. They are therefore held under this sentinel
 * (never drained, never listed) until `claimLegacyRows` re-keys them to the
 * first SERVER-confirmed principal after the upgrade. `@` cannot appear in
 * a server UUID, so the sentinel can never collide with a real user id.
 */
export const LEGACY_USER_ID = '@legacy';

/**
 * Re-keys legacy-owned rows to `userId` — the id the SERVER returned for
 * the currently authenticated principal (bootstrap `user.id`). Called from
 * `bootstrap()` on every run; a no-op unless legacy rows exist.
 *
 * Ownership rule (H-4, review-adopted): the legacy cached job carries the
 * SERVER-attested `Job.assignedTo` from the device's last pre-upgrade
 * bootstrap, and result capture requires assignment-to-self — so a queued
 * edit's owner is the job's assignee, on the server's own say-so. Rows
 * whose job's `assignedTo` MATCHES the signing-in principal are claimed;
 * rows attested to a DIFFERENT user are QUARANTINED (left `@legacy`, never
 * drained, surfaced by the job list — see `legacyHoldSummary`) until that
 * user signs in. Only rows with no surviving job or no recorded assignee
 * fall back to first-principal claim — for those the owner genuinely is
 * unrecorded, and that fallback is never WORSE than the pre-slice-16 code,
 * which drained the whole outbox under whatever bearer was present.
 * Refusing to claim those at all would strand unsent records forever — the
 * one unforgivable outcome.
 */
export async function claimLegacyRows(db: BamFormDB, userId: string): Promise<void> {
  await db.transaction('rw', db.outbox, db.jobs, async () => {
    const legacyJobs = await db.jobs.where('userId').equals(LEGACY_USER_ID).toArray();
    // Owner hints, captured BEFORE any job is re-keyed.
    const hintByJobId = new Map<string, string | null>(
      legacyJobs.map((row) => [row.id, row.job.assignedTo ?? null]),
    );

    await db.outbox
      .where('userId')
      .equals(LEGACY_USER_ID)
      .modify((row: OutboxEntry) => {
        const hint = hintByJobId.get(row.jobId);
        // hint === undefined: no surviving job → unrecorded owner → fallback.
        // hint === null: job survives but carries no assignee → fallback.
        // hint === userId: server-attested match → claim.
        // hint === someone else: quarantine — do not touch.
        if (hint == null || hint === userId) row.userId = userId;
      });

    for (const row of legacyJobs) {
      const hint = hintByJobId.get(row.id);
      if (hint != null && hint !== userId) continue; // quarantined for its own user
      // Delete-then-add (not put) because the primary key [userId+id]
      // itself changes; `add` (not put) so an existing row already owned by
      // this user is never silently overwritten — the legacy copy is kept
      // only where no claimed copy exists.
      await db.jobs.delete([LEGACY_USER_ID, row.id]);
      const alreadyClaimed = await db.jobs.get([userId, row.id]);
      if (!alreadyClaimed) await db.jobs.add({ ...row, userId });
    }
  });
}

/**
 * H-4 visibility: what the device is holding in quarantine for OTHER users
 * — so the job list can say so instead of the rows sitting invisibly.
 */
export interface LegacyHoldSummary {
  /** Quarantined (still `@legacy`) unsent outbox rows on this device. */
  count: number;
  /** Server-attested display names of the users the held work belongs to
   * (from the legacy jobs' `assignedToName`), where known. */
  names: string[];
}

export async function legacyHoldSummary(db: BamFormDB): Promise<LegacyHoldSummary> {
  const rows = await db.outbox.where('userId').equals(LEGACY_USER_ID).toArray();
  if (rows.length === 0) return { count: 0, names: [] };
  const legacyJobs = await db.jobs.where('userId').equals(LEGACY_USER_ID).toArray();
  const nameByJobId = new Map(legacyJobs.map((j) => [j.id, j.job.assignedToName ?? null]));
  const names = [
    ...new Set(
      rows
        .map((r) => nameByJobId.get(r.jobId))
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];
  return { count: rows.length, names };
}

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
  /** Backed by the `jobs2` object store since schema v2 (see constructor)
   * — compound primary key `[userId+id]`. */
  jobs!: Table<CachedJob, [string, string]>;
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

    // ---- Slice 16 (SYS-6): per-user partition. ----
    //
    // v2 is ADDITIVE: it stamps `userId` onto every outbox row and copies
    // every cached job into the new `jobs2` store (created because
    // IndexedDB cannot change an existing store's primary key in place —
    // `jobs` needs to move from `id` to `[userId+id]`). The copy happens
    // inside the same versionchange transaction IndexedDB runs the schema
    // upgrade in, so a crash mid-upgrade rolls the whole thing back — a
    // live device mid-upgrade holding unsent results can never end up
    // half-migrated or emptied. v3 then drops the old `jobs` store, whose
    // contents were already copied by v2 (Dexie applies v2's upgrade —
    // including the copy — before v3's schema delta, in that same
    // transaction).
    this.version(2)
      .stores({
        outbox:
          'id, sequence, jobId, status, [jobId+status], userId, [userId+status], [userId+jobId]',
        jobs2: '[userId+id], userId',
      })
      .upgrade(async (tx) => {
        await tx
          .table('outbox')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.userId !== 'string') row.userId = LEGACY_USER_ID;
          });
        const oldJobs = await tx.table('jobs').toArray();
        if (oldJobs.length > 0) {
          await tx
            .table('jobs2')
            .bulkAdd(oldJobs.map((job: CachedJob) => ({ ...job, userId: LEGACY_USER_ID })));
        }
      });
    this.version(3).stores({ jobs: null });

    // The `jobs` PROPERTY keeps its name so every call site and test reads
    // naturally; only the underlying object-store name changed (see v2).
    this.jobs = this.table('jobs2');

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
