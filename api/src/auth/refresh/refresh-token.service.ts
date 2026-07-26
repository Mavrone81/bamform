import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { toBytes } from '../../common/prisma-bytes';
import { SecurityAuditService } from '../audit/security-audit.service';

export interface IssuedRefreshToken {
  /** Opaque, 256-bit, base64url — the value placed in the `bf_refresh` cookie. */
  token: string;
  familyId: string;
  expiresAt: Date;
}

export interface RequestMeta {
  userAgent?: string;
  sourceIp?: string;
  requestId?: string;
}

export type RotateOutcome =
  | { status: 'rotated'; userId: string; refreshToken: IssuedRefreshToken }
  | { status: 'reuse_detected' }
  | { status: 'invalid' };

/**
 * PR-084: opaque 256-bit refresh tokens, stored only as a SHA-256 hash,
 * single-use with rotation and reuse detection. Detected reuse revokes the
 * entire token family and raises a security audit event.
 *
 * Every method takes an explicit Prisma client (`tx` from a caller-owned
 * `$transaction`) rather than opening its own — PR-098 requires the audit
 * write to share the transaction with the change it describes, and the
 * top-level caller (`AuthService`) is what defines that boundary.
 *
 * `rotate()` deliberately RETURNS an outcome instead of throwing on reuse:
 * an interactive Prisma `$transaction` rolls back everything the callback
 * did the moment it throws, which would silently undo the very family
 * revocation this method just committed. `AuthService` inspects the
 * returned status once the transaction has committed and raises the HTTP
 * error from outside it.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly config: ConfigService,
    private readonly securityAudit: SecurityAuditService,
  ) {}

  private get ttlMs(): number {
    const days = Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30);
    return days * 24 * 60 * 60 * 1000;
  }

  private generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(token: string): Buffer {
    return createHash('sha256').update(token, 'utf8').digest();
  }

  private async createToken(
    tx: Prisma.TransactionClient,
    userId: string,
    familyId: string,
    meta: RequestMeta,
  ): Promise<IssuedRefreshToken> {
    const token = this.generateOpaqueToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs);

    await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: toBytes(this.hash(token)),
        familyId,
        issuedAt,
        expiresAt,
        userAgent: meta.userAgent,
        sourceIp: meta.sourceIp,
      },
    });

    return { token, familyId, expiresAt };
  }

  /** Starts a brand new rotation family — used on successful login. */
  issueNewFamily(
    tx: Prisma.TransactionClient,
    userId: string,
    meta: RequestMeta,
  ): Promise<IssuedRefreshToken> {
    return this.createToken(tx, userId, uuidv7(), meta);
  }

  async rotate(
    tx: Prisma.TransactionClient,
    presentedToken: string,
    meta: RequestMeta,
  ): Promise<RotateOutcome> {
    const tokenHash = toBytes(this.hash(presentedToken));
    const row = await tx.refreshToken.findUnique({ where: { tokenHash } });

    if (!row || row.revokedAt) {
      return { status: 'invalid' };
    }

    if (row.usedAt) {
      await tx.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'reuse_detected' },
      });
      await this.securityAudit.recordRefreshReuseDetected(tx, {
        userId: row.userId,
        familyId: row.familyId,
        sourceIp: meta.sourceIp,
        requestId: meta.requestId,
      });
      return { status: 'reuse_detected' };
    }

    if (row.expiresAt.getTime() < Date.now()) {
      return { status: 'invalid' };
    }

    await tx.refreshToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    const refreshToken = await this.createToken(tx, row.userId, row.familyId, meta);

    return { status: 'rotated', userId: row.userId, refreshToken };
  }

  /**
   * Slice 13-MFA §7 — resolves which rotation family a presented refresh
   * token belongs to, so `POST /auth/password` can revoke every OTHER family
   * without logging the user out of the device they are standing at.
   * Returns `undefined` for an unknown token.
   */
  async familyIdForToken(
    tx: Prisma.TransactionClient,
    presentedToken: string,
  ): Promise<string | undefined> {
    const row = await tx.refreshToken.findUnique({
      where: { tokenHash: toBytes(this.hash(presentedToken)) },
      select: { familyId: true },
    });
    return row?.familyId;
  }

  /**
   * Slice 13-MFA §7 — a password change must not leave old sessions alive.
   * Revokes every live refresh-token family for the user except
   * `keepFamilyId` (the caller's own). Returns the number of token rows
   * revoked, for the audit event.
   */
  async revokeOtherFamiliesForUser(
    tx: Prisma.TransactionClient,
    userId: string,
    keepFamilyId?: string,
  ): Promise<number> {
    const { count } = await tx.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        familyId: keepFamilyId ? { not: keepFamilyId } : undefined,
      },
      data: { revokedAt: new Date(), revokedReason: 'password_changed' },
    });
    return count;
  }

  /** Revokes the whole family the presented token belongs to (logout). */
  async revokeFamilyByToken(tx: Prisma.TransactionClient, presentedToken: string): Promise<void> {
    const tokenHash = toBytes(this.hash(presentedToken));
    const row = await tx.refreshToken.findUnique({ where: { tokenHash } });
    if (!row) {
      return;
    }
    await tx.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
  }
}
