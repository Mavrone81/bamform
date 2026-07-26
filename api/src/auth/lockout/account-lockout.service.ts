import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecurityAuditService } from '../audit/security-audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { invalidCredentialsProblem, RateLimitedException } from '../problems';
import type { RequestMeta } from '../refresh/refresh-token.service';

export interface LockableUser {
  id: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

/**
 * PR-092's account lockout — 5 failures, exponential backoff — extracted from
 * `AuthService.login` in slice 13-MFA so the **second factor shares the same
 * counter as the first**.
 *
 * That sharing is the point, not an implementation nicety. A correct password
 * followed by unlimited TOTP guesses is a 10^6 search space with no wall in
 * front of it; the per-minute rate limit alone would still allow ~14k guesses
 * a day. Feeding MFA failures into the SAME `app_user.failed_login_count`
 * means five bad codes lock the account exactly as five bad passwords do
 * (brief §4).
 */
@Injectable()
export class AccountLockoutService {
  constructor(
    private readonly config: ConfigService,
    private readonly securityAudit: SecurityAuditService,
  ) {}

  private get maxAttempts(): number {
    return Number(this.config.get('LOGIN_MAX_ATTEMPTS') ?? 5);
  }

  private get lockoutBaseSeconds(): number {
    return Number(this.config.get('LOGIN_LOCKOUT_SECONDS') ?? 900);
  }

  /** Throws `429 /errors/rate-limited` with `Retry-After` if the account is currently locked. */
  assertNotLocked(user: LockableUser): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new RateLimitedException(
        retryAfterSeconds,
        'Account is temporarily locked after repeated failed attempts.',
      );
    }
  }

  /**
   * Records one failed authentication attempt against `user`, locking the
   * account when the threshold is reached, and RETURNS the exception the
   * caller must throw — 429 with `Retry-After` if this attempt caused the
   * lockout, otherwise the opaque 401 `/errors/unauthenticated`.
   *
   * Returning rather than throwing is deliberate: `throw await
   * lockout.recordFailure(...)` is a statement TypeScript's control-flow
   * analysis understands as terminating, so the code after it is correctly
   * treated as unreachable and any narrowing (e.g. "the row is non-null from
   * here on") holds. An `async` helper that throws internally does not give
   * the caller that.
   */
  async recordFailure(
    prisma: PrismaService,
    user: LockableUser,
    meta: RequestMeta,
  ): Promise<RateLimitedException | ReturnType<typeof invalidCredentialsProblem>> {
    const newCount = user.failedLoginCount + 1;
    const locked = newCount >= this.maxAttempts;
    // Exponential backoff (PR-092): each lockout beyond the threshold doubles
    // the base window, derived purely from failedLoginCount so no extra
    // schema column is needed.
    const lockedUntil = locked
      ? new Date(Date.now() + this.lockoutBaseSeconds * 1000 * 2 ** (newCount - this.maxAttempts))
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: user.id },
        data: { failedLoginCount: newCount, lockedUntil },
      });
      await this.securityAudit.recordLoginFailure(tx, {
        userId: user.id,
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
        lockout: locked,
      });
    });

    if (locked) {
      // `lockedUntil` is non-null exactly when `locked` is true (both derive
      // from the same condition above) — compute Retry-After from the actual,
      // exponentially-backed-off timestamp just stored, not the un-multiplied
      // base window, so the header agrees with `lockedUntil` on this same
      // response instead of only self-correcting on the next request.
      const retryAfterSeconds = Math.ceil((lockedUntil!.getTime() - Date.now()) / 1000);
      return new RateLimitedException(
        retryAfterSeconds,
        'Account locked after repeated failed attempts.',
      );
    }
    return invalidCredentialsProblem();
  }
}
