import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthResult } from '@bamform/shared';
import type { Prisma } from '@prisma/client';
import { FIELD_ENCRYPTION_SERVICE } from '../../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../../crypto/field-encryption';
import { SecurityAuditService } from '../audit/security-audit.service';
import { ACCESS_TOKEN_SERVICE } from '../auth.tokens';
import { buildCurrentUser } from '../current-user.builder';
import type { AccessTokenService } from '../jwt/access-token.service';
import type { IssuedRefreshToken, RequestMeta } from '../refresh/refresh-token.service';
import { RefreshTokenService } from '../refresh/refresh-token.service';

export interface AuthOutcome {
  result: AuthResult;
  refreshToken: IssuedRefreshToken;
}

/**
 * The single place a successful authentication turns into a session: reset
 * the lockout counters, stamp `last_login_at`/`last_authenticated_at`, write
 * the `login` audit event, open a fresh refresh-token family, and mint the
 * access token.
 *
 * Extracted verbatim from `AuthService.login`'s success transaction in slice
 * 13-MFA so that `POST /auth/mfa/verify`, `POST /auth/mfa/recovery` and the
 * enrol-completes-login path issue byte-identically the same thing password
 * login does — rather than each growing its own near-copy that drifts. There
 * is exactly one definition of "logged in".
 *
 * Always called with a transactional client: the audit write must share the
 * transaction with the state change it describes (PR-098/INV-09).
 */
@Injectable()
export class SessionIssuerService {
  constructor(
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly securityAudit: SecurityAuditService,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  private get accessTokenTtlSeconds(): number {
    return Number(this.config.get('ACCESS_TOKEN_TTL_SECONDS') ?? 900);
  }

  private get stepUpWindowSeconds(): number {
    return Number(this.config.get('STEP_UP_WINDOW_SECONDS') ?? 900);
  }

  async issue(
    tx: Prisma.TransactionClient,
    userId: string,
    meta: RequestMeta,
  ): Promise<AuthOutcome> {
    const now = new Date();
    await tx.appUser.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
        lastAuthenticatedAt: now,
      },
    });
    await this.securityAudit.recordLoginSuccess(tx, {
      userId,
      sourceIp: meta.sourceIp,
      requestId: meta.requestId,
    });

    const refreshToken = await this.refreshTokens.issueNewFamily(tx, userId, meta);
    const roles = await rolesFor(tx, userId);
    const { token: accessToken } = await this.accessTokens.sign(userId, roles);
    const currentUser = await buildCurrentUser(
      tx,
      userId,
      this.stepUpWindowSeconds,
      this.fieldEncryption,
    );

    return {
      refreshToken,
      result: { accessToken, expiresIn: this.accessTokenTtlSeconds, user: currentUser },
    };
  }
}

/**
 * Slice 13a: `active: false` is how `PATCH /users/{id}` revokes a role
 * without a `DELETE` (INV-16) — excluded here so a revoked role never makes
 * it into a freshly-minted access token, or into the MFA-required-role
 * decision at login.
 */
export async function rolesFor(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const userRoles = await tx.userRole.findMany({
    where: { userId, active: true },
    include: { role: true },
  });
  return userRoles.map((userRole) => userRole.role.code);
}
