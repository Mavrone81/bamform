import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { canonicalSerialise, type CanonicalValue } from '../crypto/canonical-serialiser';
import { idempotencyMismatchProblem } from './domain-problems';
import { toBytes } from './prisma-bytes';
import { PrismaService } from '../prisma/prisma.service';

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (PR-062, DBD §6.23)

export interface IdempotentResponse<T> {
  status: number;
  body: T;
}

/**
 * PR-API-16/PR-062/DBD §6.23 — the offline outbox's replay-safety mechanism.
 * `job.items.{id}`/`job.measurements.{id}`/`jobs.{id}/attachments` (PUT/POST
 * endpoints reachable from the outbox) call this to make a retransmitted
 * mutation a safe no-op instead of a double-apply.
 *
 * Two-phase, matching PR-098's "audit shares the mutation's transaction"
 * shape for the SAME reason: `checkReplay` runs BEFORE the mutation's own
 * transaction opens (so a genuine replay short-circuits without touching the
 * domain tables at all); `recordWithin` runs INSIDE the caller's existing
 * `prisma.$transaction`, so the `idempotency_key` row commits atomically with
 * the mutation it describes — a crash between the two would otherwise let a
 * retry silently re-apply.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** SHA-256 over the canonical (byte-deterministic) serialisation of the request body. */
  fingerprint(body: CanonicalValue): Buffer {
    return createHash('sha256').update(canonicalSerialise(body)).digest();
  }

  /**
   * Pre-flight check. Returns the cached response on a genuine replay (same
   * key, same fingerprint, same user); returns `null` when this key has
   * never been seen (caller should proceed to run the mutation); throws
   * `422 /errors/idempotency-mismatch` when the same key arrives with a
   * DIFFERENT body OR from a DIFFERENT user — that is a client defect, not a
   * retry (DBD §6.23).
   *
   * DBD §6.23: "key scope is per user" — `key` is the table's sole primary
   * key (client-generated UUIDv7s collide with negligible probability, PR-062),
   * but the `userId` check here is what actually ENFORCES that scoping rather
   * than merely documenting it: without it, a caller who somehow learned
   * another user's `Idempotency-Key` (and could reconstruct an identical
   * request body) could replay THEIR cached response — the authorisation
   * check that ran on the original request would never re-run.
   */
  async checkReplay(
    key: string,
    fingerprint: Buffer,
    userId: string,
  ): Promise<IdempotentResponse<unknown> | null> {
    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (!existing) {
      return null;
    }
    if (
      existing.userId !== userId ||
      !Buffer.from(existing.requestFingerprint).equals(fingerprint)
    ) {
      throw idempotencyMismatchProblem();
    }
    return { status: existing.responseStatus, body: existing.responseBody };
  }

  /** Records the response against the key, IN the caller's open transaction (see class doc). */
  async recordWithin(
    tx: Prisma.TransactionClient,
    params: { key: string; userId: string; endpoint: string; fingerprint: Buffer },
    response: IdempotentResponse<unknown>,
  ): Promise<void> {
    await tx.idempotencyKey.create({
      data: {
        key: params.key,
        userId: params.userId,
        endpoint: params.endpoint,
        requestFingerprint: toBytes(params.fingerprint),
        responseStatus: response.status,
        responseBody: response.body as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
  }
}
