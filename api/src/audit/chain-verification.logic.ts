/**
 * PR-097/PR-099 — pure break-detection logic for the audit hash chain,
 * separated from `chain-verification.service.ts`'s Postgres access so it can
 * be unit-tested with synthetic fixtures (no database) per slice-8-brief.md's
 * "U-level unit test for the verifier's break-detection logic (mutated
 * field, broken link, gap) with fixtures."
 *
 * `expectedHash` on each row is NOT recomputed here — see
 * `chain-verification.service.ts`'s header for why byte-exact reproduction
 * of `compute_audit_event_hash_chain()`'s formula (the jsonb/timestamptz
 * casts in particular) is delegated to Postgres itself via a `digest(...)`
 * SQL expression identical to the trigger's. This module only compares
 * already-computed values: `expectedHash` vs `hash` (mutated field), and
 * `prevHash` vs the previous row's `hash` in chain order (broken link, which
 * also catches a deleted row — see below).
 *
 * DELIBERATELY NOT CHECKED: numeric contiguity of `sequence` (e.g.
 * `row.sequence === lastSequence + 1`). This was the initial design — the
 * slice-8-brief.md calls out "a deleted/inserted row (sequence gap or
 * relink)" as something to detect — but an empirical run of the S-10/S-11-
 * style integration tests (I-INV-12, real Postgres, zero tampering) caught
 * it as a FALSE BREAK on every single ordinary insert: the fixed trigger
 * (`api/prisma/migrations/20260724010000_.../migration.sql:60-97`) redraws
 * `NEW."sequence"` via a SECOND `nextval()` call *inside* the advisory-lock
 * section, discarding the value the column default already drew *before*
 * the BEFORE-ROW trigger fired. That means EVERY committed row — not just
 * ones from a rolled-back concurrent transaction — consumes two ticks of
 * the underlying `BIGSERIAL` and stores only the second, so consecutive
 * rows normally differ by exactly 2 (verified directly against a running
 * Postgres: three sequential single-row inserts landed at sequence 2, 4, 6).
 * Treating that as "a break" would cry wolf on literally every write.
 * A genuinely deleted row is still caught, reliably, by the LINK check
 * alone: the next surviving row's stored `prevHash` was fixed at insert
 * time to the deleted row's `hash`, which no longer matches anything in the
 * scan once that row is gone — no numeric-gap heuristic is needed, or
 * trustworthy, on top of that.
 */

export interface AuditChainRow {
  sequence: bigint;
  prevHash: Buffer | null;
  hash: Buffer;
  /** Recomputed by Postgres from this row's OWN current fields + its OWN stored prevHash. */
  expectedHash: Buffer;
}

export interface ChainWalkState {
  /** `null` only before the very first row of the whole table has been seen. */
  lastSequence: bigint | null;
  lastHash: Buffer | null;
}

export const INITIAL_CHAIN_WALK_STATE: ChainWalkState = { lastSequence: null, lastHash: null };

export interface ChainWalkOutcome {
  state: ChainWalkState;
  /** `null` if every row processed in this page verified clean. */
  firstBreakSequence: bigint | null;
}

/**
 * Verifies one page of rows (already ordered ascending by `sequence`)
 * against carried-over `state` from the previous page (or
 * `INITIAL_CHAIN_WALK_STATE` for the first page). Stops at the first row
 * that fails either check, in this order:
 *
 *  1. Link — `row.prevHash` must equal the previous row's `hash` (or be
 *     `null` if this is the very first row in the whole table). A deleted
 *     intermediate row surfaces here: the next surviving row's `prevHash`
 *     no longer matches anything in the scan.
 *  2. Content — `row.expectedHash` (recomputed from row's current fields)
 *     must equal the stored `row.hash`. Catches any single mutated field,
 *     including a directly-tampered `hash` column itself.
 */
export function walkChainPage(
  rows: readonly AuditChainRow[],
  state: ChainWalkState = INITIAL_CHAIN_WALK_STATE,
): ChainWalkOutcome {
  let lastSequence = state.lastSequence;
  let lastHash = state.lastHash;

  for (const row of rows) {
    const linkOk =
      lastHash === null ? row.prevHash === null : (row.prevHash?.equals(lastHash) ?? false);
    if (!linkOk) {
      return { state: { lastSequence, lastHash }, firstBreakSequence: row.sequence };
    }

    if (!row.expectedHash.equals(row.hash)) {
      return { state: { lastSequence, lastHash }, firstBreakSequence: row.sequence };
    }

    lastSequence = row.sequence;
    lastHash = row.hash;
  }

  return { state: { lastSequence, lastHash }, firstBreakSequence: null };
}
