import { Injectable } from '@nestjs/common';
import { AuditActionT } from '@prisma/client';
import { AuditEventService } from '../../audit/audit-event.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MfaConfig } from '../mfa/mfa.config';
import { invalidCredentialsProblem, RateLimitedException } from '../problems';
import { RateLimiterService } from '../redis/rate-limiter.service';
import type { RequestMeta } from '../refresh/refresh-token.service';
import { RefreshTokenService } from '../refresh/refresh-token.service';
import { PasswordService } from './password.service';

/**
 * Slice 13-MFA §7 — `POST /auth/password`, the self-service password change
 * that closes slice 13a's deferred gap.
 *
 * The gap: `POST /users` lets an ADMIN choose a new user's password, and
 * before this endpoint existed the user had no way to change it. The admin
 * therefore knew every user's credential indefinitely, which makes signature
 * attribution under ISO 13485 indefensible — "the maintainer signed it" is
 * not a claim you can stand behind if an administrator could have signed as
 * them.
 */
@Injectable()
export class PasswordChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditEventService,
    private readonly mfaConfig: MfaConfig,
  ) {}

  /**
   * Own account only — `userId` comes from the verified access token, never
   * from the request body, so there is no "change someone else's password"
   * shape to abuse.
   *
   * On success:
   *  - `password_changed_at` is stamped,
   *  - `must_change_password` is cleared (this is the only thing that clears
   *    it — an admin cannot clear it on a user's behalf),
   *  - every OTHER refresh-token family is revoked. A password change is a
   *    "someone may have had this" event; leaving old sessions alive would
   *    make it cosmetic. The caller's own family survives, so the user is not
   *    logged out of the device they just used.
   *  - a `password_changed` audit event is written in the same transaction
   *    (INV-09). It records that the change happened, never any password
   *    material.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta & { currentRefreshToken?: string },
  ): Promise<void> {
    const rate = await this.rateLimiter.checkAndIncrement(
      'password-change',
      userId,
      this.mfaConfig.passwordChangeRateLimitPerMinute,
    );
    if (rate.limited) {
      throw new RateLimitedException(
        rate.retryAfterSeconds,
        'Too many password-change attempts. Try again later.',
      );
    }

    // `findUnique` + an explicit 401, not `findUniqueOrThrow`: there is no
    // global exception filter in `api/src`, so Prisma's P2025 would leave a
    // bare `500 {"statusCode":500,...}` — the defect review finding I-1
    // caught on the ADMIN reset. Unreachable today (no DELETE grant on
    // `app_user`, INV-16) but a principal that no longer resolves is an
    // authentication failure, not an internal error.
    const user = await this.prisma.appUser.findUnique({ where: { id: userId } });
    if (!user) {
      throw invalidCredentialsProblem();
    }

    const currentValid = user.passwordHash
      ? await this.passwordService.verify(user.passwordHash, currentPassword)
      : false;
    if (!currentValid) {
      // Deliberately NOT fed into the account-lockout counter. This path
      // already requires a valid access token, is rate-limited per user, and
      // locking the account here would hand any holder of a stolen token a
      // trivial denial-of-service against the real owner. The MFA paths are
      // different: those are reachable with the password alone, pre-session.
      throw invalidCredentialsProblem();
    }

    const newHash = await this.passwordService.hash(newPassword);

    // Identify the family to keep BEFORE the transaction so the revocation
    // predicate is a single statement inside it.
    const keepFamilyId = meta.currentRefreshToken
      ? await this.refreshTokens.familyIdForToken(this.prisma, meta.currentRefreshToken)
      : undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
        },
      });

      const revoked = await this.refreshTokens.revokeOtherFamiliesForUser(tx, userId, keepFamilyId);

      await this.audit.record(tx, {
        actorId: userId,
        action: AuditActionT.password_changed,
        entityType: 'app_user',
        entityId: userId,
        before: { mustChangePassword: user.mustChangePassword },
        // No password material of any kind — only the fact and its effects.
        after: {
          event: 'password_changed',
          mustChangePassword: false,
          otherSessionsRevoked: revoked,
        },
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });
    });
  }
}
