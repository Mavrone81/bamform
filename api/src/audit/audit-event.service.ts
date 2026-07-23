import { Injectable } from '@nestjs/common';
import { AuditActionT, type Prisma } from '@prisma/client';

export interface RecordAuditEventParams {
  actorId: string | null;
  action: AuditActionT;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  onBehalfOfId?: string;
  sourceIp?: string;
  requestId?: string;
}

/**
 * Generic `audit_event` writer for entity mutations (asset/area/asset-type
 * CRUD, template revision lifecycle transitions, and every later slice's
 * mutations) — non-negotiable #3 (BUILD_HANDOFF): "An action that can't be
 * audited doesn't happen."
 *
 * This generalises the transactional-write pattern
 * `auth/audit/security-audit.service.ts` (slice 2) established for
 * auth-specific events (login/step-up), which has no method shaped for an
 * arbitrary entity mutation with before/after state. Both services write
 * through the SAME table and the SAME trigger
 * (`compute_audit_event_hash_chain`, slice 1); they are deliberately kept
 * separate because `SecurityAuditService`'s methods encode auth-specific
 * business meaning (event kind, PII-free tagging) this generic writer must
 * not know about.
 *
 * Callers MUST pass the transactional client (`tx` from `prisma.$transaction`)
 * so the audit write shares the same transaction as the change it describes
 * (PR-098) — never call this outside a transaction for a mutation.
 */
@Injectable()
export class AuditEventService {
  async record(tx: Prisma.TransactionClient, params: RecordAuditEventParams): Promise<void> {
    await tx.auditEvent.create({
      data: {
        occurredAt: new Date(),
        actorId: params.actorId,
        onBehalfOfId: params.onBehalfOfId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        before: params.before as Prisma.InputJsonValue | undefined,
        after: params.after as Prisma.InputJsonValue | undefined,
        sourceIp: params.sourceIp,
        requestId: params.requestId,
        hash: Buffer.alloc(32), // overwritten by audit_event_hash_chain_trg
      },
    });
  }
}
