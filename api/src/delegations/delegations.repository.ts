import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateDelegationData {
  id: string;
  delegatorId: string;
  delegateId: string;
  validFrom: Date;
  validTo: Date;
  reason: string | null;
  createdBy: string;
}

/**
 * DB access for `delegation` (DBD §6.5, PR-038) — kept separate from
 * `DelegationsService` (business rules) mirroring `approval.repository.ts`'s
 * split for `jobs`/`approval`. No `.delete(` call anywhere in this file —
 * BUILD_HANDOFF non-negotiable #7 (no hard DELETE); `revoke` is an
 * `UPDATE ... SET revoked_at`.
 */
@Injectable()
export class DelegationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(tx: Prisma.TransactionClient, data: CreateDelegationData) {
    return tx.delegation.create({
      data: {
        id: data.id,
        delegatorId: data.delegatorId,
        delegateId: data.delegateId,
        validFrom: data.validFrom,
        validTo: data.validTo,
        reason: data.reason,
        createdBy: data.createdBy,
      },
    });
  }

  findById(id: string) {
    return this.prisma.delegation.findUnique({ where: { id } });
  }

  /** The caller's grants (as delegator) + grants to them (as delegate) — API_SPECIFICATION.md `GET /delegations`. */
  findForUser(userId: string, afterId: string | undefined, take: number) {
    return this.prisma.delegation.findMany({
      where: {
        OR: [{ delegatorId: userId }, { delegateId: userId }],
        id: afterId ? { gt: afterId } : undefined,
      },
      include: { delegator: true, delegate: true },
      orderBy: { id: 'asc' },
      take,
    });
  }

  /**
   * Active delegations (non-revoked, window contains `now`) FROM other users
   * TO `delegateId` — PR-076's "plus that of any delegator whose delegation
   * window contains the current instant", the direction `GET /queue` needs
   * (given a delegate, find their delegators). Same window semantics as
   * `approval.repository.ts#findActiveDelegation` (`validTo: { gt: now }`,
   * exclusive upper bound) — the S-25 ground truth `VerificationService`
   * actually enforces when `onBehalfOf` is used — so a queue entry present
   * because of a delegation is always one `POST /jobs/{id}/verify?onBehalfOf=`
   * would actually honour at that same instant.
   */
  findActiveDelegatorsFor(delegateId: string, now: Date) {
    return this.prisma.delegation.findMany({
      where: {
        delegateId,
        revokedAt: null,
        validFrom: { lte: now },
        validTo: { gt: now },
      },
      select: { delegatorId: true },
    });
  }

  async revoke(tx: Prisma.TransactionClient, id: string, revokedAt: Date) {
    return tx.delegation.update({ where: { id }, data: { revokedAt } });
  }
}
