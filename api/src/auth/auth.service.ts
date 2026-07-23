import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthResult, LoginRequest } from '@bamform/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toBytes } from '../common/prisma-bytes';
import { SecurityAuditService } from './audit/security-audit.service';
import { ACCESS_TOKEN_SERVICE, BLIND_INDEX_KEY } from './auth.tokens';
import { computeEmailBlindIndex } from './crypto/blind-index';
import { buildCurrentUser } from './current-user.builder';
import type { AccessTokenService } from './jwt/access-token.service';
import { PasswordService } from './password/password.service';
import { invalidCredentialsProblem, RateLimitedException } from './problems';
import { LoginRateLimiterService } from './redis/login-rate-limiter.service';
import { TokenDenylistService } from './redis/token-denylist.service';
import type { IssuedRefreshToken, RequestMeta } from './refresh/refresh-token.service';
import { RefreshTokenService } from './refresh/refresh-token.service';
import {
  invalidRefreshTokenError,
  refreshReuseDetectedError,
} from './refresh/refresh-token.errors';

export interface AuthOutcome {
  result: AuthResult;
  refreshToken: IssuedRefreshToken;
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
    private readonly rateLimiter: LoginRateLimiterService,
    private readonly denylist: TokenDenylistService,
    @Inject(BLIND_INDEX_KEY) private readonly blindIndexKey: Buffer,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
  ) {}

  private get maxAttempts(): number {
    return Number(this.config.get('LOGIN_MAX_ATTEMPTS') ?? 5);
  }

  private get lockoutBaseSeconds(): number {
    return Number(this.config.get('LOGIN_LOCKOUT_SECONDS') ?? 900);
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

  async login(dto: LoginRequest, meta: RequestMeta): Promise<AuthOutcome> {
    const rate = await this.rateLimiter.checkAndIncrement(meta.sourceIp ?? 'unknown');
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

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new RateLimitedException(
        retryAfterSeconds,
        'Account is temporarily locked after repeated failed attempts.',
      );
    }

    const passwordValid = user.passwordHash
      ? await this.passwordService.verify(user.passwordHash, dto.password)
      : false;

    if (!passwordValid) {
      const newCount = user.failedLoginCount + 1;
      const locked = newCount >= this.maxAttempts;
      // Exponential backoff (PR-092): each lockout beyond the threshold
      // doubles the base window, derived purely from failedLoginCount so no
      // extra schema column is needed.
      const lockedUntil = locked
        ? new Date(Date.now() + this.lockoutBaseSeconds * 1000 * 2 ** (newCount - this.maxAttempts))
        : null;

      await this.prisma.$transaction(async (tx) => {
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
        throw new RateLimitedException(
          this.lockoutBaseSeconds,
          'Account locked after repeated failed attempts.',
        );
      }
      throw invalidCredentialsProblem();
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.appUser.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          lastAuthenticatedAt: now,
        },
      });
      await this.securityAudit.recordLoginSuccess(tx, {
        userId: user.id,
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });

      const refreshToken = await this.refreshTokens.issueNewFamily(tx, user.id, meta);
      const roles = await this.rolesFor(tx, user.id);
      const { token: accessToken } = await this.accessTokens.sign(user.id, roles);
      const currentUser = await buildCurrentUser(tx, user.id, this.stepUpWindowSeconds);

      return {
        refreshToken,
        result: { accessToken, expiresIn: this.accessTokenTtlSeconds, user: currentUser },
      };
    });
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

    const roles = await this.rolesFor(this.prisma, outcome.userId);
    const { token: accessToken } = await this.accessTokens.sign(outcome.userId, roles);
    const currentUser = await buildCurrentUser(
      this.prisma,
      outcome.userId,
      this.stepUpWindowSeconds,
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
    return buildCurrentUser(this.prisma, userId, this.stepUpWindowSeconds);
  }

  private async rolesFor(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
    const userRoles = await tx.userRole.findMany({ where: { userId }, include: { role: true } });
    return userRoles.map((userRole) => userRole.role.code);
  }
}
