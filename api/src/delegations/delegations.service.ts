import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditActionT } from '@prisma/client';
import type { CreateDelegationRequest, Delegation } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { forbiddenProblem, notFoundProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';
import { DelegationsRepository } from './delegations.repository';
import { toDelegation, type DelegationWithParties } from './delegations.mapper';

/** API_SPECIFICATION.md §4.1 "Create delegation" row: TEAM_LEADER, ENGINEER, ADMIN. Route-level `@Roles()` mirrors this; kept here too for the service-level ownership rule below. */
export const DELEGATION_MANAGE_ROLES = ['TEAM_LEADER', 'ENGINEER', 'ADMIN'];

export interface ListDelegationsParams {
  limit?: unknown;
  cursor?: string;
}

/**
 * PR-038/PR-076/UR-052 — delegation CRUD. "CRUD" is intentionally not
 * literal: there is no `DELETE` (BUILD_HANDOFF non-negotiable #7 — `grants.sql`
 * revokes `DELETE` on every table for `bamform_app`); `DELETE /delegations/{id}`
 * is a soft-revoke (`revoked_at`), API_SPECIFICATION.md §3's principal-endpoints
 * table is explicit about this.
 */
@Injectable()
export class DelegationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: DelegationsRepository,
    private readonly audit: AuditEventService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  async list(userId: string, params: ListDelegationsParams): Promise<Page<Delegation>> {
    const limit = normaliseLimit(params.limit);
    const rows = await this.repo.findForUser(userId, decodeCursor(params.cursor), limit + 1);
    const page = paginate(rows, limit);
    return {
      data: page.data.map((row) =>
        toDelegation(row as DelegationWithParties, this.fieldEncryption),
      ),
      page: page.page,
    };
  }

  /**
   * Not accepted from the request body: `createdBy` (always the authenticated
   * caller — PR-090, see `shared/src/delegation.ts`'s doc comment). Ownership
   * rule (not spelt out by PR-038, a deliberate, documented choice — see
   * slice-11a-report.md): `ADMIN` may create a delegation for any pair;
   * `TEAM_LEADER`/`ENGINEER` may only delegate AWAY THEIR OWN authority
   * (`delegatorId` must equal the actor) — "create delegation" being on their
   * permission row does not make them able to set up an arbitrary pair of
   * OTHER colleagues.
   */
  async create(
    actor: ActorMeta,
    roles: string[],
    dto: CreateDelegationRequest,
  ): Promise<Delegation> {
    const isAdmin = roles.includes('ADMIN');
    if (!isAdmin && dto.delegatorId !== actor.actorId) {
      throw forbiddenProblem(
        'You may only create a delegation delegating your OWN authority (delegatorId must be you), unless you hold ADMIN.',
      );
    }

    const [delegator, delegate] = await Promise.all([
      this.prisma.appUser.findUnique({ where: { id: dto.delegatorId } }),
      this.prisma.appUser.findUnique({ where: { id: dto.delegateId } }),
    ]);
    if (!delegator) throw notFoundProblem('User', dto.delegatorId);
    if (!delegate) throw notFoundProblem('User', dto.delegateId);

    const id = randomUUID();
    const validFrom = new Date(dto.validFrom);
    const validTo = new Date(dto.validTo);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await this.repo.create(tx, {
        id,
        delegatorId: dto.delegatorId,
        delegateId: dto.delegateId,
        validFrom,
        validTo,
        reason: dto.reason ?? null,
        createdBy: actor.actorId,
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.create,
        entityType: 'delegation',
        entityId: id,
        after: {
          delegatorId: dto.delegatorId,
          delegateId: dto.delegateId,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
        },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return tx.delegation.findUniqueOrThrow({
        where: { id: created.id },
        include: { delegator: true, delegate: true },
      });
    });

    return toDelegation(row, this.fieldEncryption);
  }

  /**
   * Soft-revoke (`revoked_at`) — early termination of a delegation before its
   * `valid_to`. Permitted for `ADMIN`, the delegation's own `delegatorId`
   * (the person whose authority it is), or its `createdBy` (whoever set it
   * up) — same reasoning as `create`'s ownership rule above.
   */
  async revoke(actor: ActorMeta, roles: string[], id: string): Promise<Delegation> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw notFoundProblem('Delegation', id);
    }
    const isAdmin = roles.includes('ADMIN');
    if (
      !isAdmin &&
      existing.delegatorId !== actor.actorId &&
      existing.createdBy !== actor.actorId
    ) {
      throw forbiddenProblem(
        'Only ADMIN, the delegator, or whoever created this delegation may revoke it.',
      );
    }
    if (existing.revokedAt) {
      // Already revoked — idempotent no-op, not an error (INV: revocation is a one-way state).
      const row = await this.prisma.delegation.findUniqueOrThrow({
        where: { id },
        include: { delegator: true, delegate: true },
      });
      return toDelegation(row, this.fieldEncryption);
    }

    const revokedAt = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      await this.repo.revoke(tx, id, revokedAt);

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'delegation',
        entityId: id,
        before: { revokedAt: null },
        after: { revokedAt: revokedAt.toISOString() },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return tx.delegation.findUniqueOrThrow({
        where: { id },
        include: { delegator: true, delegate: true },
      });
    });

    return toDelegation(row, this.fieldEncryption);
  }
}
