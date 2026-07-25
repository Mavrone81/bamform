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

  private async fetchPage(afterSequence: bigint, limit: number): Promise<AuditChainRow[]> {
    const rows = await this.prisma.$queryRaw<RawChainRow[]>(Prisma.sql`
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
  }
}
