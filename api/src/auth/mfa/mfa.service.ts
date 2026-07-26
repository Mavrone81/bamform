import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { MfaEnrolConfirmResponse, MfaEnrolResponse } from '@bamform/shared';
import { AuditActionT, Prisma, type AppUser } from '@prisma/client';
import { AuditEventService } from '../../audit/audit-event.service';
import { notFoundProblem } from '../../common/domain-problems';
import { toBytes } from '../../common/prisma-bytes';
import { isUuid } from '../../common/uuid';
import { FIELD_ENCRYPTION_SERVICE } from '../../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../../crypto/field-encryption';
import { PrismaService } from '../../prisma/prisma.service';
import { BLIND_INDEX_KEY } from '../auth.tokens';
import { computeRecoveryCodeBlindIndex } from '../crypto/blind-index';
import { decodeIdentityField } from '../crypto/identity-codec';
import { AccountLockoutService } from '../lockout/account-lockout.service';
import { invalidCredentialsProblem, RateLimitedException } from '../problems';
import { RateLimiterService } from '../redis/rate-limiter.service';
import { TokenDenylistService } from '../redis/token-denylist.service';
import type { RequestMeta } from '../refresh/refresh-token.service';
import { SessionIssuerService, type AuthOutcome } from '../session/session-issuer.service';
import { base32Decode, base32Encode } from './base32';
import { MfaConfig } from './mfa.config';
import { generateRecoveryCodes } from './recovery-codes';
import { buildOtpauthUri, currentTotpStep, generateTotpSecret, verifyTotp } from './totp';

/** Where the caller's authority for an MFA operation came from. */
export interface MfaActor {
  userId: string;
  /** Present when the caller arrived on an MFA challenge token (mid-login). */
  challenge?: { jti: string; exp: number };
}

const MFA_SECRET_COLUMN = 'mfa_secret_ct';
const MFA_SECRET_TABLE = 'app_user';

/**
 * `app_user.mfa_last_used_step` is BIGINT (Prisma `bigint`) so the counter can
 * never wrap; `verifyTotp` works in `number`. A TOTP step is
 * unix-seconds / 30 — about 5.8e7 today and ~7e7 in the year 2100 — so the
 * conversion is exact, many orders of magnitude below `Number.MAX_SAFE_INTEGER`.
 */
function toStep(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Slice 13-MFA — TOTP enrolment, challenge verification, recovery codes and
 * the ADMIN reset (brief §§4-5, §8).
 *
 * ## Things a reviewer should check are actually here
 *
 * 1. **Replay guard.** Every accepted TOTP step is written to
 *    `app_user.mfa_last_used_step` in the SAME transaction that issues the
 *    session, by a CONDITIONAL `updateMany` whose predicate is the guard
 *    itself, so it holds under concurrency and not merely in sequence. A
 *    captured code cannot be reused inside its own 30 s window (RFC 6238
 *    §5.2), even by simultaneous requests.
 * 2. **Shared lockout.** Every failed code or recovery code goes through
 *    `AccountLockoutService.recordFailure`, i.e. the same
 *    `failed_login_count` a wrong password increments. Every entry point
 *    calls `assertNotLocked` first.
 * 3. **Single-use challenge.** A redeemed challenge token's `jti` is claimed
 *    with a single Redis `SET NX` — inside the issuing transaction and before
 *    the session exists — so exactly one request can ever spend a given
 *    challenge, and it cannot complete a second login.
 * 4. **Nothing is logged.** No method here logs, and no secret, recovery
 *    code or TOTP code is ever placed in an audit `before`/`after` payload
 *    (PR-SEC-02 already forbids personal data there; credential material even
 *    more so).
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mfaConfig: MfaConfig,
    private readonly lockout: AccountLockoutService,
    private readonly sessions: SessionIssuerService,
    private readonly rateLimiter: RateLimiterService,
    private readonly denylist: TokenDenylistService,
    private readonly audit: AuditEventService,
    @Inject(BLIND_INDEX_KEY) private readonly blindIndexKey: Buffer,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  // ------------------------------------------------------------- enrolment

  /**
   * `POST /auth/mfa/enrol` — mint a fresh secret, store it encrypted, leave
   * `mfa_enrolled` false until the user proves they scanned it.
   *
   * Re-calling before confirmation REPLACES the pending secret, so a user who
   * abandoned a half-finished scan can restart (brief §5).
   *
   * A user who is ALREADY enrolled is refused (409), whichever credential
   * they present. Two reasons, and the first is a real hole if you get it
   * wrong: on a challenge token the caller has proven only the PASSWORD, so
   * letting them re-enrol would let anyone holding a stolen password swap in
   * their own authenticator and walk straight past MFA. And on an access
   * token it matches the brief's own rule that "users may not self-disable
   * MFA while holding a required role" — re-enrolment is a disable-and-
   * re-enable in disguise. The only way out of an enrolled state is the
   * ADMIN reset.
   *
   * Rate-limited and lockout-checked like its three siblings (review finding
   * M-4). It was the only MFA entry point with neither, and it is reachable
   * on a challenge token — i.e. with the password alone — for that token's
   * five-minute life, so an unbounded caller could drive an unlimited number
   * of 160-bit secret generations, AES-GCM encrypts and row updates.
   */
  async enrol(actor: MfaActor): Promise<MfaEnrolResponse> {
    await this.enforceRateLimit('mfa-enrol', actor.userId, this.mfaConfig.enrolRateLimitPerMinute);

    const user = await this.subjectOf(actor.userId);
    this.lockout.assertNotLocked(user);

    if (user.mfaEnrolled) {
      throw new ConflictException({
        type: '/errors/mfa-already-enrolled',
        title: 'Multi-factor authentication is already set up',
        status: 409,
        detail:
          'This account already has an authenticator enrolled. An administrator must reset it before a new one can be added.',
      });
    }

    const secret = generateTotpSecret();
    const encrypted = this.fieldEncryption.encrypt(base32Encode(secret), {
      table: MFA_SECRET_TABLE,
      column: MFA_SECRET_COLUMN,
      rowId: user.id,
    });

    await this.prisma.appUser.update({
      where: { id: user.id },
      data: {
        mfaSecretCt: toBytes(encrypted.ciphertext),
        mfaSecretDekVersion: encrypted.dekVersion,
        // A restart must not inherit the previous attempt's replay high-water
        // mark — a new secret is a new counter.
        mfaLastUsedStep: null,
      },
    });

    const base32Secret = base32Encode(secret);
    return {
      secret: base32Secret,
      otpauthUri: buildOtpauthUri({
        issuer: this.mfaConfig.issuer,
        accountName: this.accountName(user),
        base32Secret,
      }),
    };
  }

  /**
   * `POST /auth/mfa/enrol/confirm` — verify a code against the pending
   * secret, flip `mfa_enrolled`, mint the ten recovery codes and return them
   * ONCE. If the caller arrived on a challenge token, this also completes
   * their login (brief §4.4).
   */
  async confirmEnrolment(
    actor: MfaActor,
    code: string,
    meta: RequestMeta,
  ): Promise<{ response: MfaEnrolConfirmResponse; refreshToken?: AuthOutcome['refreshToken'] }> {
    await this.enforceRateLimit(
      'mfa-enrol-confirm',
      actor.userId,
      this.mfaConfig.verifyRateLimitPerMinute,
    );

    const user = await this.subjectOf(actor.userId);
    this.lockout.assertNotLocked(user);

    if (user.mfaEnrolled || !user.mfaSecretCt || user.mfaSecretDekVersion === null) {
      // No pending enrolment to confirm. Reported as invalid credentials, not
      // as a distinct state, so the endpoint gives an unauthenticated caller
      // no signal about the account.
      throw invalidCredentialsProblem();
    }

    const secret = this.decodeSecret(user);
    const verification = verifyTotp(secret, code, currentTotpStep(), toStep(user.mfaLastUsedStep));
    if (!verification.valid) {
      throw await this.lockout.recordFailure(this.prisma, user, meta);
    }

    const recoveryCodes = generateRecoveryCodes();
    const now = new Date();

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Atomic, for the same reason `verify` is (I-2): without the
      // `mfaEnrolled: false` predicate, three concurrent confirms on one
      // challenge token all flipped the flag and each minted its own ten
      // recovery codes — thirty rows for one enrolment. The step predicate
      // rides along so a confirm cannot replay a step either.
      const enrolled = await tx.appUser.updateMany({
        where: {
          id: user.id,
          mfaEnrolled: false,
          ...stepNotYetUsed(verification.step!),
        },
        data: {
          mfaEnrolled: true,
          mfaEnrolledAt: now,
          mfaLastUsedStep: BigInt(verification.step!),
        },
      });
      if (enrolled.count !== 1) {
        throw invalidCredentialsProblem();
      }

      for (const recoveryCode of recoveryCodes) {
        await tx.mfaRecoveryCode.create({
          data: {
            userId: user.id,
            codeBidx: toBytes(computeRecoveryCodeBlindIndex(recoveryCode, this.blindIndexKey)),
          },
        });
      }

      // INV-09/PR-098: same transaction as the change. `after` carries a
      // COUNT, never a code.
      await this.audit.record(tx, {
        actorId: user.id,
        action: AuditActionT.mfa_enrolled,
        entityType: 'app_user',
        entityId: user.id,
        after: { event: 'mfa_enrolled', recoveryCodesIssued: recoveryCodes.length },
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });

      if (!actor.challenge) {
        return undefined;
      }
      await this.claimChallenge(actor);
      return this.sessions.issue(tx, user.id, meta);
    });

    return {
      response: { recoveryCodes, auth: outcome?.result ?? null },
      refreshToken: outcome?.refreshToken,
    };
  }

  // ------------------------------------------------------------ verification

  /** `POST /auth/mfa/verify` — the second step of login. */
  async verify(actor: MfaActor, code: string, meta: RequestMeta): Promise<AuthOutcome> {
    await this.enforceRateLimit(
      'mfa-verify',
      actor.userId,
      this.mfaConfig.verifyRateLimitPerMinute,
    );

    const user = await this.subjectOf(actor.userId);
    this.lockout.assertNotLocked(user);

    if (!user.mfaEnrolled || !user.mfaSecretCt || user.mfaSecretDekVersion === null) {
      throw invalidCredentialsProblem();
    }

    const verification = verifyTotp(
      this.decodeSecret(user),
      code,
      currentTotpStep(),
      toStep(user.mfaLastUsedStep),
    );
    if (!verification.valid) {
      throw await this.lockout.recordFailure(this.prisma, user, meta);
    }

    return this.prisma.$transaction(async (tx) => {
      // RFC 6238 §5.2 replay guard, made ATOMIC (review finding I-2). The
      // pre-check inside `verifyTotp` above reads `mfa_last_used_step`
      // OUTSIDE any transaction, so on its own it is a read-then-write race:
      // three simultaneous verifies carrying the same captured code all read
      // the old value and all three were accepted. Putting the predicate in
      // the WHERE clause makes Postgres arbitrate — under READ COMMITTED the
      // second writer blocks on the row lock and then re-evaluates the
      // predicate against the committed row, so exactly one `updateMany` can
      // report `count === 1`. Same shape as the recovery-code redemption
      // below; the two single-use primitives now use one pattern.
      await this.burnTotpStep(tx, user.id, verification.step!);
      // ...and the challenge token itself is burned before a session exists,
      // not after. Needed as well as the step guard: two concurrent verifies
      // carrying codes from DIFFERENT steps (t-1 and t) can BOTH satisfy the
      // step predicate if they commit in ascending order, and only the
      // single-use claim on the `jti` stops the second one.
      await this.claimChallenge(actor);
      return this.sessions.issue(tx, user.id, meta);
    });
  }

  /**
   * `POST /auth/mfa/recovery` — redeem one of the ten single-use codes.
   * O(1): a unique-index lookup on the keyed blind index, not a scan over
   * candidate Argon2id hashes (see `computeRecoveryCodeBlindIndex`).
   */
  async redeemRecoveryCode(actor: MfaActor, code: string, meta: RequestMeta): Promise<AuthOutcome> {
    await this.enforceRateLimit(
      'mfa-recovery',
      actor.userId,
      this.mfaConfig.recoveryRateLimitPerMinute,
    );

    const user = await this.subjectOf(actor.userId);
    this.lockout.assertNotLocked(user);

    const bidx = toBytes(computeRecoveryCodeBlindIndex(code, this.blindIndexKey));
    const row = await this.prisma.mfaRecoveryCode.findUnique({ where: { codeBidx: bidx } });

    // The row must exist, be unused, AND belong to this user — the last check
    // matters because `code_bidx` is globally unique, so without it a code
    // issued to a DIFFERENT user would authenticate this one.
    if (!row || row.usedAt !== null || row.userId !== user.id) {
      throw await this.lockout.recordFailure(this.prisma, user, meta);
    }

    return this.prisma.$transaction(async (tx) => {
      // INV-07/INV-16: marked used, NEVER deleted. `updateMany` with
      // `usedAt: null` in the predicate makes the redemption atomic — two
      // concurrent requests with the same code cannot both see a count of 1.
      const marked = await tx.mfaRecoveryCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (marked.count !== 1) {
        throw invalidCredentialsProblem();
      }

      const remaining = await tx.mfaRecoveryCode.count({
        where: { userId: user.id, usedAt: null },
      });

      await this.audit.record(tx, {
        actorId: user.id,
        action: AuditActionT.mfa_recovery_code_used,
        entityType: 'app_user',
        entityId: user.id,
        // The code itself is never recorded. The row id identifies WHICH code
        // was spent without disclosing it.
        after: { event: 'mfa_recovery_code_used', recoveryCodeId: row.id, remaining },
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });

      await this.claimChallenge(actor);
      return this.sessions.issue(tx, user.id, meta);
    });
  }

  // ----------------------------------------------------------- ADMIN reset

  /**
   * `POST /users/{userId}/mfa-reset` — ADMIN only (enforced by `@Roles` on
   * the controller). Clears the enrolment and invalidates every unused
   * recovery code, forcing the user to enrol again from scratch.
   *
   * An admin never sees the secret or the codes: this method only writes.
   *
   * An id that names no user is the documented `404` (`openapi.yaml`'s
   * `/users/{userId}/mfa-reset` lists exactly `204/401/403/404`), raised
   * through the house `notFoundProblem` factory so the body is RFC 9457 like
   * every other error in the system. A malformed id is the same 404 rather
   * than a Prisma P2023 escaping as a 500 — review finding I-1.
   */
  async resetForUser(
    subjectUserId: string,
    actor: { actorId: string; sourceIp?: string; requestId?: string },
  ): Promise<void> {
    const subject = isUuid(subjectUserId)
      ? await this.prisma.appUser.findUnique({ where: { id: subjectUserId } })
      : null;
    if (!subject) {
      throw notFoundProblem('User', subjectUserId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: subject.id },
        data: {
          mfaEnrolled: false,
          mfaSecretCt: null,
          mfaSecretDekVersion: null,
          mfaEnrolledAt: null,
          mfaLastUsedStep: null,
        },
      });

      // INV-07/INV-16 again: invalidated by marking, never by deleting.
      const invalidated = await tx.mfaRecoveryCode.updateMany({
        where: { userId: subject.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.mfa_reset,
        entityType: 'app_user',
        entityId: subject.id,
        before: { mfaEnrolled: subject.mfaEnrolled },
        after: {
          event: 'mfa_reset',
          mfaEnrolled: false,
          recoveryCodesInvalidated: invalidated.count,
        },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });
    });
  }

  // -------------------------------------------------------------- internals

  /**
   * The user behind an already-VERIFIED principal (an access token's `sub` or
   * a challenge token's `sub`), never an id from a request body.
   *
   * `findUniqueOrThrow` here would raise Prisma's `P2025`, and with no global
   * exception filter in `api/src` that leaves the endpoint as a bare 500 —
   * the same defect review finding I-1 caught on the ADMIN reset. Unreachable
   * today (`bamform_app` has no DELETE grant on `app_user`, INV-16, so a
   * signed token's subject always resolves), but if it ever happens it is an
   * authentication failure, not an internal error, and these endpoints answer
   * every other failure with the same opaque 401.
   */
  private async subjectOf(userId: string): Promise<AppUser> {
    const user = await this.prisma.appUser.findUnique({ where: { id: userId } });
    if (!user) {
      throw invalidCredentialsProblem();
    }
    return user;
  }

  private accountName(user: Pick<AppUser, 'id' | 'emailCt' | 'dekVersion'>): string {
    return decodeIdentityField(
      user.emailCt,
      user.dekVersion,
      { column: 'email_ct', rowId: user.id },
      this.fieldEncryption,
    );
  }

  private decodeSecret(user: AppUser): Buffer {
    return base32Decode(
      this.fieldEncryption.decrypt(user.mfaSecretCt!, user.mfaSecretDekVersion!, {
        table: MFA_SECRET_TABLE,
        column: MFA_SECRET_COLUMN,
        rowId: user.id,
      }),
    );
  }

  private async enforceRateLimit(scope: string, userId: string, limit: number): Promise<void> {
    const rate = await this.rateLimiter.checkAndIncrement(scope, userId, limit);
    if (rate.limited) {
      throw new RateLimitedException(rate.retryAfterSeconds, 'Too many attempts. Try again later.');
    }
  }

  /**
   * RFC 6238 §5.2, atomically: advance `mfa_last_used_step` to `step` only if
   * it is still strictly below it. A `count` of 0 means another request got
   * there first with the same or a later step, i.e. this is a replay — which
   * the caller reports as ordinary invalid credentials, giving an attacker no
   * signal that they lost a race rather than typed a wrong code.
   *
   * Deliberately NOT fed into the account-lockout counter: losing a race is
   * not a failed guess, and counting it would let a user with a flaky client
   * that retries lock themselves out.
   */
  private async burnTotpStep(
    tx: Prisma.TransactionClient,
    userId: string,
    step: number,
  ): Promise<void> {
    const burned = await tx.appUser.updateMany({
      where: { id: userId, ...stepNotYetUsed(step) },
      data: { mfaLastUsedStep: BigInt(step) },
    });
    if (burned.count !== 1) {
      throw invalidCredentialsProblem();
    }
  }

  /**
   * Burn the challenge token that authorised this operation, so it cannot
   * complete a second login (brief §4: a replayed challenge token is a 401).
   * Uses the same Redis `jti` denylist PR-088 already uses for logged-out
   * access tokens, but through `claim()` — a single `SET NX` — so the check
   * and the write cannot be interleaved (review finding I-2).
   *
   * Called INSIDE the issuing transaction and BEFORE `sessions.issue`, so
   * there is no instant at which a session exists on a challenge that has not
   * been burned. Redis is not transactional with Postgres, so the one
   * remaining asymmetry is fail-CLOSED: if the surrounding transaction rolls
   * back after the claim, the challenge is spent and the user logs in again.
   *
   * ACCEPTED TRADE (fix-delta re-review, FD-3): this puts a Redis round trip
   * inside the Prisma interactive transaction, while the `app_user` row lock
   * is held. A Redis stall therefore holds that lock and can burn the 5 s
   * transaction timeout, surfacing as a 500 on this one login attempt. The
   * ordering is not incidental — moving the claim outside the transaction is
   * exactly the interleaving that let three concurrent verifies mint three
   * access tokens. A single `SET NX` against loopback Redis is sub-millisecond
   * in the deployed topology (same host, no network hop), the blast radius is
   * one login rather than any data, and it fails closed. Revisit only if
   * Redis moves off-box.
   *
   * `claim()` itself is pinned by direct tests in
   * `test/integration/auth-redis-primitives.spec.ts` (FD-1): NO end-to-end
   * test can catch a regression here, because the in-process Postgres pool
   * and the row lock serialise HTTP requests before they ever reach Redis.
   */
  private async claimChallenge(actor: MfaActor): Promise<void> {
    if (!actor.challenge) {
      return;
    }
    const remainingTtl = actor.challenge.exp - Math.floor(Date.now() / 1000);
    const claimed = await this.denylist.claim(actor.challenge.jti, remainingTtl);
    if (!claimed) {
      throw invalidCredentialsProblem();
    }
  }
}

/**
 * The replay-guard predicate, shared by `verify` and `enrol/confirm` so the
 * two cannot drift: the stored high-water mark is either absent (a fresh
 * secret) or strictly older than the step being accepted.
 */
function stepNotYetUsed(step: number): Prisma.AppUserWhereInput {
  return { OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(step) } }] };
}
