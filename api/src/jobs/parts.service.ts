import { Injectable } from '@nestjs/common';
import { AuditActionT } from '@prisma/client';
import type { PartUpsertInput, PartUsed, PartUsedInput } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { notFoundProblem } from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertJobWritable } from './job-status-guard';
import { JobsService } from './jobs.service';
import { toPartUsed } from './mappers';

/**
 * PR-033/UR-034 — parts consumed per job. No `DELETE` counterpart
 * (BUILD_HANDOFF non-negotiable #7 / `grants.sql` — see `shared/src/job.ts`
 * header). `Idempotency-Key` is honoured when supplied but NOT required
 * (parts are not documented as outbox-reachable the way item/measurement
 * results are, WORKFLOW_DIAGRAMS.md §5 shows it as a simple `POST` with no
 * offline-replay callout) — a retry without a key simply records a second
 * part-consumption row, which is the correct real-world behaviour (two
 * filters really were used) unless the caller supplies a key to make the
 * retry safe.
 */
@Injectable()
export class PartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async recordPart(
    jobId: string,
    dto: PartUsedInput,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<PartUsed> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({ jobId, ...dto });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) {
        return replay.body as PartUsed;
      }
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertJobWritable(job.status);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.partUsed.create({
        data: {
          jobId,
          partNo: dto.partNo ?? null,
          description: dto.description,
          quantity: dto.quantity,
          remarks: dto.remarks ?? null,
          recordedBy: actor.actorId,
        },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.create,
        entityType: 'part_used',
        entityId: row.id,
        after: {
          partNo: row.partNo,
          description: row.description,
          quantity: row.quantity.toNumber(),
        },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      const dtoOut = toPartUsed(row);
      if (idempotencyKey && fingerprint) {
        await this.idempotency.recordWithin(
          tx,
          {
            key: idempotencyKey,
            userId: actor.actorId,
            endpoint: 'POST /jobs/{jobId}/parts',
            fingerprint,
          },
          { status: 201, body: dtoOut },
        );
      }

      return dtoOut;
    });
  }

  /**
   * Slice 30 — client-keyed create-or-update, additive to `recordPart`
   * above. Unlike `recordPart`'s server-assigned id, the caller mints
   * `partId` up front (offline-friendly: an app can create the row locally
   * before it ever reaches the server, and a network retry with the same id
   * is naturally idempotent even without an `Idempotency-Key`). `active:
   * false` is the soft-remove path (BUILD_HANDOFF non-negotiable #7 — no
   * physical `DELETE`); `active` is never part of the canonical signed
   * record (U-SIG-01) and Task 3 is responsible for filtering inactive
   * parts out of reads/canonical/PDF.
   */
  async upsertPart(
    jobId: string,
    partId: string,
    dto: PartUpsertInput,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<PartUsed> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({ jobId, partId, ...dto });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) {
        return replay.body as PartUsed;
      }
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertJobWritable(job.status);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.partUsed.findUnique({ where: { id: partId } });
      // A part id belongs to exactly one job; a mismatched job is a client bug.
      if (existing && existing.jobId !== jobId) {
        throw notFoundProblem('Part', partId);
      }

      const row = await tx.partUsed.upsert({
        where: { id: partId },
        create: {
          id: partId,
          jobId,
          partNo: dto.partNo ?? null,
          description: dto.description,
          quantity: dto.quantity,
          remarks: dto.remarks ?? null,
          active: dto.active,
          recordedBy: actor.actorId,
        },
        update: {
          partNo: dto.partNo ?? null,
          description: dto.description,
          quantity: dto.quantity,
          remarks: dto.remarks ?? null,
          active: dto.active,
        },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: existing ? AuditActionT.update : AuditActionT.create,
        entityType: 'part_used',
        entityId: row.id,
        after: {
          partNo: row.partNo,
          description: row.description,
          quantity: row.quantity.toNumber(),
          active: row.active,
        },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      const dtoOut = toPartUsed(row);
      if (idempotencyKey && fingerprint) {
        await this.idempotency.recordWithin(
          tx,
          {
            key: idempotencyKey,
            userId: actor.actorId,
            endpoint: 'PUT /jobs/{jobId}/parts/{partId}',
            fingerprint,
          },
          { status: 200, body: dtoOut },
        );
      }

      return dtoOut;
    });
  }
}
