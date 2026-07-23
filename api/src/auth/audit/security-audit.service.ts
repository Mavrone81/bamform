import { Injectable } from '@nestjs/common';
import { AuditActionT, type Prisma } from '@prisma/client';

/**
 * Writes `audit_event` rows for the auth security events SECURITY_ARCHITECTURE.md
 * §11.1 lists ("Login success/failure", "Refresh token reuse detected",
 * "Step-up success/failure"). `audit_action_t` (DATABASE_DESIGN.md §5, matched
 * exactly by `schema.prisma`) has no dedicated enum value for reuse detection,
 * lockout or step-up — it is a closed set of ten values with no provision for
 * more, so this is not a gap slice 2 needs a migration to fill. Every one of
 * these events is an authentication-attempt outcome, so they are recorded
 * under the existing `login` / `login_failed` actions, with the specific kind
 * distinguished by `entityType` + a small, PII-free `after` JSON tag
 * (PR-SEC-02: no personal data in `audit_event.before`/`after`).
 *
 * Callers MUST pass a transactional Prisma client (`tx` from
 * `prisma.$transaction`) for events that accompany a data change (PR-098:
 * audit writes share the transaction with the change they describe) — the
 * hash chain trigger (`compute_audit_event_hash_chain`) fills `hash`/`prev_hash`
 * on insert; the placeholder passed here is always overwritten.
 */
@Injectable()
export class SecurityAuditService {
  async recordLoginSuccess(
    tx: Prisma.TransactionClient,
    params: { userId: string; sourceIp?: string; requestId?: string },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        occurredAt: new Date(),
        actorId: params.userId,
        action: AuditActionT.login,
        entityType: 'app_user',
        entityId: params.userId,
        after: { event: 'login_success' },
        sourceIp: params.sourceIp,
        requestId: params.requestId,
        hash: Buffer.alloc(32), // overwritten by audit_event_hash_chain_trg
      },
    });
  }

  async recordLoginFailure(
    tx: Prisma.TransactionClient,
    params: { userId: string | null; sourceIp?: string; requestId?: string; lockout: boolean },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        occurredAt: new Date(),
        actorId: params.userId,
        action: AuditActionT.login_failed,
        entityType: 'app_user',
        entityId: params.userId,
        after: { event: params.lockout ? 'login_failed_lockout' : 'login_failed' },
        sourceIp: params.sourceIp,
        requestId: params.requestId,
        hash: Buffer.alloc(32),
      },
    });
  }

  /** SEC §4.1 S-2 / §11.1 "Refresh token reuse detected", severity high. */
  async recordRefreshReuseDetected(
    tx: Prisma.TransactionClient,
    params: { userId: string; familyId: string; sourceIp?: string; requestId?: string },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        occurredAt: new Date(),
        actorId: params.userId,
        action: AuditActionT.login_failed,
        entityType: 'refresh_token',
        entityId: params.familyId,
        after: { event: 'refresh_reuse_detected' },
        sourceIp: params.sourceIp,
        requestId: params.requestId,
        hash: Buffer.alloc(32),
      },
    });
  }

  async recordStepUp(
    tx: Prisma.TransactionClient,
    params: { userId: string; success: boolean; sourceIp?: string; requestId?: string },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        occurredAt: new Date(),
        actorId: params.userId,
        action: params.success ? AuditActionT.login : AuditActionT.login_failed,
        entityType: 'app_user',
        entityId: params.userId,
        after: { event: params.success ? 'step_up_success' : 'step_up_failed' },
        sourceIp: params.sourceIp,
        requestId: params.requestId,
        hash: Buffer.alloc(32),
      },
    });
  }
}
