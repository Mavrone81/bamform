import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AuditChainRow,
  type ChainWalkState,
  INITIAL_CHAIN_WALK_STATE,
  walkChainPage,
} from './chain-verification.logic';

export interface ChainVerificationResult {
  intact: boolean;
  checkedAt: Date;
  eventCount: number;
  firstBreakSequence: bigint | null;
}

/** Bounds memory: one page of rows (plus O(1) carried state) is ever held at once. */
const DEFAULT_PAGE_SIZE = 5000;

interface RawChainRow {
  sequence: bigint | string | number;
  prevHash: Buffer | Uint8Array | null;
  hash: Buffer | Uint8Array;
  expectedHash: Buffer | Uint8Array;
}

/**
 * PR-097/PR-099 — walks the ENTIRE `audit_event` table ordered by
 * `sequence` and verifies the hash chain the slice-1 trigger
 * (`compute_audit_event_hash_chain`, `api/prisma/migrations/20260723180000_invariants/
 * migration.sql:122-150`, re-defined byte-for-byte-identically with an
 * advisory lock added in `20260724010000_.../migration.sql:60-97`) built at
 * insert time.
 *
 * CORRECTNESS: this is the single most important piece of the slice. The
 * trigger's content string is:
 *
 *   concat_ws('|',
 *     id::text, occurred_at::text, coalesce(actor_id::text, ''),
 *     coalesce(on_behalf_of_id::text, ''), action::text, entity_type,
 *     coalesce(entity_id::text, ''), coalesce(before::text, ''),
 *     coalesce(after::text, ''), coalesce(host(source_ip), ''),
 *     coalesce(request_id, ''), coalesce(encode(prev_hash, 'hex'), '')
 *   ) -> digest(..., 'sha256')
 *
 * A JS reimplementation of this would have to byte-exactly reproduce
 * Postgres's OWN `timestamptz::text` formatting (session-timezone-dependent)
 * and `jsonb::text` canonicalisation (key ordering/whitespace) — subtle
 * enough to silently diverge and "cry wolf" (false breaks) or, worse, MISS a
 * real tamper. Instead, `fetchPage` below asks POSTGRES to recompute the
 * candidate hash via the IDENTICAL `concat_ws`/`digest`/`encode`/`host`
 * expression, in the same query that reads the row — guaranteeing a
 * byte-for-byte match with whatever the trigger produced, by construction,
 * not by careful reimplementation. `pgcrypto` (for `digest`/`encode`) is
 * already required by the trigger itself (`20260723180000_invariants/
 * migration.sql:10`), so no new extension/grant is needed.
 *
 * Full-chain re-scan every call (no persisted checkpoint) — same design
 * choice as `IntegrityService.checkIntegrity` (`api/src/jobs/integrity.service.ts`):
 * "on-demand recompute is simplest" (slice-8-brief.md). Bounded memory via
 * keyset pagination on `sequence` — only one page of rows plus the O(1)
 * `ChainWalkState` (previous row's sequence + hash) is ever held.
 *
 * KNOWN LIMITATION — TAIL-TRUNCATION IS UNDETECTABLE: this verifier proves
 * field-level integrity (no mutated column), link integrity (no broken
 * `prev_hash` -> `hash` chain), and that no row was deleted from the MIDDLE
 * or HEAD of the table (the next surviving row's stored `prev_hash` would no
 * longer match anything). It CANNOT detect deletion of the most-RECENT N
 * rows: with the tail gone, the remaining chain is still fully
 * self-consistent end-to-end and reports `intact: true`. Detecting that
 * requires an EXTERNAL anchor (an off-box published/attested chain head) to
 * compare against — an in-database high-water-mark/heartbeat table was
 * deliberately REJECTED as a "fix" here, because the only actors who can
 * delete `audit_event` rows at all are owner/DBA-level (the application role
 * is grant-denied `DELETE` on `audit_event` — see migration grants — so the
 * in-threat-model compromised-API truncation vector, E-8, is already
 * blocked); an in-DB anchor is just as editable by that same DBA/owner actor
 * and would add complexity without real defense. External anchoring is
 * tracked as future work, not built in this slice.
 */
@Injectable()
export class ChainVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async verify(pageSize: number = DEFAULT_PAGE_SIZE): Promise<ChainVerificationResult> {
    let state: ChainWalkState = INITIAL_CHAIN_WALK_STATE;
    let eventCount = 0;
    let firstBreakSequence: bigint | null = null;
    let afterSequence = -1n;

    for (;;) {
      const rows = await this.fetchPage(afterSequence, pageSize);
      if (rows.length === 0) {
        break;
      }
      eventCount += rows.length;

      const outcome = walkChainPage(rows, state);
      state = outcome.state;
      firstBreakSequence = outcome.firstBreakSequence;

      if (firstBreakSequence !== null) {
        break; // fail fast — no value in scanning past the first detected break
      }

      afterSequence = rows[rows.length - 1].sequence;

      if (rows.length < pageSize) {
        break; // last page
      }
    }

    return {
      intact: firstBreakSequence === null,
      checkedAt: new Date(),
      eventCount,
      firstBreakSequence,
    };
  }

  /**
   * TIMEZONE PINNING: `occurred_at::text` (below) renders per the SESSION's
   * `TimeZone` GUC, and the slice-1 trigger (`compute_audit_event_hash_chain`)
   * computed the STORED hash using whatever `TimeZone` was in effect on the
   * INSERTING session — `UTC`, confirmed as this deployment's Postgres
   * default (`postgres:16-alpine`, unset `TZ` → `SHOW TimeZone` = `UTC`; see
   * `docker-compose.yml`/`docker-compose.test.yml`, neither sets `TZ`). A
   * verifier connection is a DIFFERENT session and could inherit a different
   * `TimeZone` (a client-side `PGTZ`/`TZ` env var, a role/database-level
   * `ALTER ROLE ... SET TimeZone`, etc.) — if it ever did, `occurred_at::text`
   * here would render differently than it did at insert time and EVERY row
   * would false-break, even with zero tampering. `SET LOCAL TimeZone = 'UTC'`
   * pins this session to the same TZ the trigger assumed, scoped to the
   * transaction (`LOCAL` + the transaction commit/rollback below both cause
   * it to revert automatically) so it never leaks onto the pooled
   * connection. This does NOT change the digest/concat_ws formula itself —
   * only which session GUC is in effect while Postgres evaluates it.
   */
  private async fetchPage(afterSequence: bigint, limit: number): Promise<AuditChainRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TimeZone = 'UTC'`;

      const rows = await tx.$queryRaw<RawChainRow[]>(Prisma.sql`
        SELECT
          "sequence"                        AS "sequence",
          "prev_hash"                       AS "prevHash",
          "hash"                            AS "hash",
          digest(
            concat_ws('|',
              "id"::text,
              "occurred_at"::text,
              coalesce("actor_id"::text, ''),
              coalesce("on_behalf_of_id"::text, ''),
              "action"::text,
              "entity_type",
              coalesce("entity_id"::text, ''),
              coalesce("before"::text, ''),
              coalesce("after"::text, ''),
              coalesce(host("source_ip"), ''),
              coalesce("request_id", ''),
              coalesce(encode("prev_hash", 'hex'), '')
            ),
            'sha256'
          )                                  AS "expectedHash"
        FROM "audit_event"
        WHERE "sequence" > ${afterSequence}
        ORDER BY "sequence" ASC
        LIMIT ${limit}
      `);

      return rows.map((row) => ({
        sequence: BigInt(row.sequence),
        prevHash: row.prevHash ? Buffer.from(row.prevHash) : null,
        hash: Buffer.from(row.hash),
        expectedHash: Buffer.from(row.expectedHash),
      }));
    });
  }
}
