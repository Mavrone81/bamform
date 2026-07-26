import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { MfaEnrolConfirmResponse, MfaEnrolResponse } from '@bamform/shared';
import { AuditActionT, type AppUser } from '@prisma/client';
import { AuditEventService } from '../../audit/audit-event.service';
import { toBytes } from '../../common/prisma-bytes';
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
 *    session, and `verifyTotp` refuses any step `<=` it. A captured code
 *    cannot be reused inside its own 30 s window (RFC 6238 §5.2).
 * 2. **Shared lockout.** Every failed code or recovery code goes through
 *    `AccountLockoutService.recordFailure`, i.e. the same
 *    `failed_login_count` a wrong password increments.
 * 3. **Single-use challenge.** A redeemed challenge token's `jti` is
 *    denylisted for its remaining life, so it cannot complete a second login.
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
   */
  async enrol(actor: MfaActor): Promise<MfaEnrolResponse> {
    const user = await this.prisma.appUser.findUniqueOrThrow({ where: { id: actor.userId } });

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

    const user = await this.prisma.appUser.findUniqueOrThrow({ where: { id: actor.userId } });
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
      await tx.appUser.update({
        where: { id: user.id },
        data: {
          mfaEnrolled: true,
          mfaEnrolledAt: now,
          mfaLastUsedStep: BigInt(verification.step!),
        },
      });

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

      return actor.challenge ? await this.sessions.issue(tx, user.id, meta) : undefined;
    });

    await this.consumeChallenge(actor);

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

    const user = await this.prisma.appUser.findUniqueOrThrow({ where: { id: actor.userId } });
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

    const outcome = await this.prisma.$transaction(async (tx) => {
      // RFC 6238 §5.2 replay guard. Written in the SAME transaction as the
      // session issue, so there is no window in which a session exists but
      // the step has not been burned.
      await tx.appUser.update({
        where: { id: user.id },
        data: { mfaLastUsedStep: BigInt(verification.step!) },
      });
      return this.sessions.issue(tx, user.id, meta);
    });

    await this.consumeChallenge(actor);
    return outcome;
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

    const user = await this.prisma.appUser.findUniqueOrThrow({ where: { id: actor.userId } });
    this.lockout.assertNotLocked(user);

    const bidx = toBytes(computeRecoveryCodeBlindIndex(code, this.blindIndexKey));
    const row = await this.prisma.mfaRecoveryCode.findUnique({ where: { codeBidx: bidx } });

    // The row must exist, be unused, AND belong to this user — the last check
    // matters because `code_bidx` is globally unique, so without it a code
    // issued to a DIFFERENT user would authenticate this one.
    if (!row || row.usedAt !== null || row.userId !== user.id) {
      throw await this.lockout.recordFailure(this.prisma, user, meta);
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
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

      return this.sessions.issue(tx, user.id, meta);
    });

    await this.consumeChallenge(actor);
    return outcome;
  }

  // ----------------------------------------------------------- ADMIN reset

  /**
   * `POST /users/{userId}/mfa-reset` — ADMIN only (enforced by `@Roles` on
   * the controller). Clears the enrolment and invalidates every unused
   * recovery code, forcing the user to enrol again from scratch.
   *
   * An admin never sees the secret or the codes: this method only writes.
   */
  async resetForUser(
    subjectUserId: string,
    actor: { actorId: string; sourceIp?: string; requestId?: string },
  ): Promise<void> {
    const subject = await this.prisma.appUser.findUniqueOrThrow({ where: { id: subjectUserId } });

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
   * Burn the challenge token that authorised this operation, so it cannot
   * complete a second login (brief §4: a replayed challenge token is a 401).
   * Uses the same Redis `jti` denylist PR-088 already uses for logged-out
   * access tokens.
   */
  private async consumeChallenge(actor: MfaActor): Promise<void> {
    if (!actor.challenge) {
      return;
    }
    const remainingTtl = actor.challenge.exp - Math.floor(Date.now() / 1000);
    await this.denylist.denylist(actor.challenge.jti, remainingTtl);
  }
}
