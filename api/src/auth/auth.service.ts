import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LoginRequest, LoginResponse } from '@bamform/shared';
import { UserStatusT } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toBytes } from '../common/prisma-bytes';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import { SecurityAuditService } from './audit/security-audit.service';
import { ACCESS_TOKEN_SERVICE, BLIND_INDEX_KEY } from './auth.tokens';
import { computeEmailBlindIndex } from './crypto/blind-index';
import { buildCurrentUser } from './current-user.builder';
import type { AccessTokenService } from './jwt/access-token.service';
import { AccountLockoutService } from './lockout/account-lockout.service';
import { MfaConfig } from './mfa/mfa.config';
import { MFA_CHALLENGE_TOKEN_SERVICE } from './mfa/mfa.tokens';
import type { MfaChallengeTokenService } from './mfa/mfa-challenge-token.service';
import { PasswordService } from './password/password.service';
import { invalidCredentialsProblem, RateLimitedException } from './problems';
import { RateLimiterService } from './redis/rate-limiter.service';
import { TokenDenylistService } from './redis/token-denylist.service';
import type { RequestMeta } from './refresh/refresh-token.service';
import { RefreshTokenService } from './refresh/refresh-token.service';
import {
  invalidRefreshTokenError,
  refreshReuseDetectedError,
} from './refresh/refresh-token.errors';
import { rolesFor, SessionIssuerService, type AuthOutcome } from './session/session-issuer.service';

export type { AuthOutcome } from './session/session-issuer.service';

/**
 * `POST /auth/login`'s outcome. `refreshToken` is `undefined` in exactly one
 * case: an MFA challenge was issued instead of a session, so there is no
 * cookie to set (brief §4.2 — "issue **no access token and no refresh
 * cookie**").
 */
export interface LoginOutcome {
  result: LoginResponse;
  refreshToken?: AuthOutcome['refreshToken'];
}

const DECOY_PASSWORD_FOR_TIMING = 'decoy-password-not-a-real-account-000000';

@Injectable()
export class AuthService {
  private dummyHashPromise?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly passwordService: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityAudit: SecurityAuditService,
    private readonly rateLimiter: RateLimiterService,
    private readonly denylist: TokenDenylistService,
    private readonly lockout: AccountLockoutService,
    private readonly sessions: SessionIssuerService,
    private readonly mfaConfig: MfaConfig,
    @Inject(BLIND_INDEX_KEY) private readonly blindIndexKey: Buffer,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
    @Inject(MFA_CHALLENGE_TOKEN_SERVICE)
    private readonly mfaChallengeTokens: MfaChallengeTokenService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  private get loginRateLimitPerMinute(): number {
    return Number(this.config.get('RATE_LIMIT_LOGIN_PER_MIN') ?? 10);
  }

  /**
   * API_SPECIFICATION.md §9: `POST /auth/step-up → 10/min per user → 429`.
   * Keyed by `user.sub` (not IP) because step-up already presumes a valid
   * access token — the threat is a stolen/valid token being used to
   * brute-force the account password, which an IP-keyed limiter would not
   * stop (PR-091/PR-092).
   */
  private get stepUpRateLimitPerMinute(): number {
    return Number(this.config.get('RATE_LIMIT_STEP_UP_PER_MIN') ?? 10);
  }

  private get stepUpWindowSeconds(): number {
    return Number(this.config.get('STEP_UP_WINDOW_SECONDS') ?? 900);
  }

  private get accessTokenTtlSeconds(): number {
    return Number(this.config.get('ACCESS_TOKEN_TTL_SECONDS') ?? 900);
  }

  /** Computed once and reused so a lookup miss costs the same as a real verify (no user enumeration via timing). */
  private dummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = this.passwordService.hash(DECOY_PASSWORD_FOR_TIMING);
    }
    return this.dummyHashPromise;
  }

  async login(dto: LoginRequest, meta: RequestMeta): Promise<LoginOutcome> {
    const rate = await this.rateLimiter.checkAndIncrement(
      'login',
      meta.sourceIp ?? 'unknown',
      this.loginRateLimitPerMinute,
    );
    if (rate.limited) {
      throw new RateLimitedException(
        rate.retryAfterSeconds,
        'Too many login attempts from this address. Try again later.',
      );
    }

    const bidx = computeEmailBlindIndex(dto.email, this.blindIndexKey);
    const user = await this.prisma.appUser.findUnique({ where: { emailBidx: toBytes(bidx) } });

    if (!user) {
      await this.passwordService.verify(await this.dummyHash(), dto.password);
      await this.securityAudit.recordLoginFailure(this.prisma, {
        userId: null,
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
        lockout: false,
      });
      throw invalidCredentialsProblem();
    }

    this.lockout.assertNotLocked(user);

    const passwordValid = user.passwordHash
      ? await this.passwordService.verify(user.passwordHash, dto.password)
      : false;

    // Slice 13a/UR-075: `PATCH /users/{id}` deactivates via `status`, never a
    // hard delete — so a deactivated (or suspended) account must be denied
    // here too, not just cosmetically flagged. Folded into the SAME branch
    // `!passwordValid` already uses (same failure-handling transaction, same
    // `invalidCredentialsProblem()`/lockout response) rather than a separate
    // early-return, so the Argon2id verify above still always runs first and
    // a deactivated account is not distinguishable from a wrong password by
    // response shape or timing (no new user-enumeration oracle).
    const accountActive = user.status === UserStatusT.active;

    if (!passwordValid || !accountActive) {
      throw await this.lockout.recordFailure(this.prisma, user, meta);
    }

    // ------------------------------------------------------------ MFA gate
    //
    // ⚠️ `MfaConfig.isMfaRequiredForRoles` returns false whenever
    // `MFA_ENABLED` is false — which is the DEFAULT and the only value in
    // committed config. With the flag off this branch is never taken and the
    // code below is byte-for-byte the pre-13-MFA login path (brief §2; the
    // live sole ADMIN must keep logging in one step until slice 13-UI ships).
    if (this.mfaConfig.enabled) {
      const roles = await rolesFor(this.prisma, user.id);
      if (this.mfaConfig.isMfaRequiredForRoles(roles)) {
        const challenge = await this.mfaChallengeTokens.sign(user.id);
        // Deliberately NO session side effects here: `failed_login_count` is
        // NOT reset, `last_login_at`/`last_authenticated_at` are NOT stamped
        // and no `login` audit event is written. The password is only half
        // the credential — leaving the counter running is what makes the
        // shared lockout in §4 actually bite (otherwise every fresh
        // /auth/login would reset an attacker's MFA guess budget), and the
        // audit trail should record "logged in" only when the user really is.
        return {
          result: {
            mfaRequired: true,
            mfaEnrolled: user.mfaEnrolled,
            challengeToken: challenge.token,
            expiresIn: challenge.expiresIn,
          },
        };
      }
    }

    return this.prisma.$transaction((tx) => this.sessions.issue(tx, user.id, meta));
  }

  async refresh(presentedToken: string | undefined, meta: RequestMeta): Promise<AuthOutcome> {
    if (!presentedToken) {
      throw invalidRefreshTokenError();
    }

    const outcome = await this.prisma.$transaction((tx) =>
      this.refreshTokens.rotate(tx, presentedToken, meta),
    );

    if (outcome.status === 'invalid') {
      throw invalidRefreshTokenError();
    }
    if (outcome.status === 'reuse_detected') {
      throw refreshReuseDetectedError();
    }

    // Slice 13a/UR-075: `status` is re-checked HERE (not just at login) —
    // `PATCH /users/{id}` can deactivate a user any time after they logged
    // in, and a long-lived refresh token must not go on minting fresh
    // ≤15min access tokens for an account that's since been deactivated.
    // Same opaque `invalidRefreshTokenError()` as any other invalid/expired
    // refresh token — deactivation is not surfaced as a distinct reason.
    const currentAccount = await this.prisma.appUser.findUnique({
      where: { id: outcome.userId },
      select: { status: true },
    });
    if (!currentAccount || currentAccount.status !== UserStatusT.active) {
      throw invalidRefreshTokenError();
    }

    const roles = await rolesFor(this.prisma, outcome.userId);
    const { token: accessToken } = await this.accessTokens.sign(outcome.userId, roles);
    const currentUser = await buildCurrentUser(
      this.prisma,
      outcome.userId,
      this.stepUpWindowSeconds,
      this.fieldEncryption,
    );

    return {
      refreshToken: outcome.refreshToken,
      result: { accessToken, expiresIn: this.accessTokenTtlSeconds, user: currentUser },
    };
  }

  async logout(params: {
    jti: string;
    accessTokenExpiresAt: number; // epoch seconds
    presentedRefreshToken?: string;
  }): Promise<void> {
    const remainingTtl = params.accessTokenExpiresAt - Math.floor(Date.now() / 1000);
    await this.denylist.denylist(params.jti, remainingTtl);

    if (params.presentedRefreshToken) {
      await this.prisma.$transaction((tx) =>
        this.refreshTokens.revokeFamilyByToken(tx, params.presentedRefreshToken as string),
      );
    }
  }

  async stepUp(
    userId: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ stepUpValidUntil: string }> {
    // PR-091/PR-092, API_SPECIFICATION.md §9: 10/min per user, checked before
    // password verification. Without this, a stolen/valid access token lets
    // an attacker brute-force the account password via step-up with no
    // lockout in the way (login's account lockout never runs on this path).
    //
    // D-2: step-up stays PASSWORD-ONLY. TOTP is deliberately not added here —
    // a cleanroom operator re-authenticating before every signature is
    // exactly the usability cliff SEC RS-3/SO-3 warns about.
    const rate = await this.rateLimiter.checkAndIncrement(
      'step-up',
      userId,
      this.stepUpRateLimitPerMinute,
    );
    if (rate.limited) {
      throw new RateLimitedException(
        rate.retryAfterSeconds,
        'Too many step-up attempts. Try again later.',
      );
    }

    const user = await this.prisma.appUser.findUniqueOrThrow({ where: { id: userId } });
    const valid = user.passwordHash
      ? await this.passwordService.verify(user.passwordHash, password)
      : false;

    if (!valid) {
      await this.securityAudit.recordStepUp(this.prisma, {
        userId,
        success: false,
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });
      throw invalidCredentialsProblem();
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.appUser.update({ where: { id: userId }, data: { lastAuthenticatedAt: now } });
      await this.securityAudit.recordStepUp(tx, {
        userId,
        success: true,
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });
    });

    return {
      stepUpValidUntil: new Date(now.getTime() + this.stepUpWindowSeconds * 1000).toISOString(),
    };
  }

  me(userId: string): ReturnType<typeof buildCurrentUser> {
    return buildCurrentUser(this.prisma, userId, this.stepUpWindowSeconds, this.fieldEncryption);
  }
}
