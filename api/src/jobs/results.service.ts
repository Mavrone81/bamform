import { Injectable } from '@nestjs/common';
import { AuditActionT, JobStatusT, type Prisma } from '@prisma/client';
import type {
  ItemResultInput,
  ItemResult,
  MeasurementResultInput,
  MeasurementResult,
} from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import {
  draftConflictProblem,
  idempotencyKeyRequiredProblem,
  notFoundProblem,
} from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeJudgement } from './judgement';
import { ITEM_STATUS_TO_DB, JUDGEMENT_TO_DB } from './job-enums';
import { assertJobWritable } from './job-status-guard';
import { JobsService } from './jobs.service';
import { toItemResult, toMeasurementResult } from './mappers';
import { SPEC_TYPE_FROM_DB } from '../templates/mappers';

export interface RecordResultParams {
  idempotencyKey?: string;
  ifMatch?: string;
}

/**
 * PR-031/032 — result capture against the job's FROZEN template revision
 * (active items/measurements only, DP-3/PR-049). Every mutation:
 *  - is gated by `assertJobWritable` (job must be ASSIGNED/IN_PROGRESS),
 *  - transitions ASSIGNED -> IN_PROGRESS on the first result (PRD §5.1),
 *  - honours `Idempotency-Key` (PR-API-16, REQUIRED here — this endpoint is
 *    reachable from the offline outbox, WORKFLOW_DIAGRAMS.md §6),
 *  - honours `If-Match` against `job.draftVersion` when the header is
 *    supplied (PR-API-18) — optional, since neither PRD/API_SPECIFICATION.md
 *    state it as unconditionally mandatory the way Idempotency-Key is,
 *    see slice-6-report.md,
 *  - writes `item_result`/`measurement_result` AND `audit_event` in ONE
 *    transaction (non-negotiable #3).
 */
@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async recordItemResult(
    jobId: string,
    templateItemId: string,
    dto: ItemResultInput,
    params: RecordResultParams,
    actor: ActorMeta,
    roles: string[],
  ): Promise<ItemResult> {
    if (!params.idempotencyKey) {
      throw idempotencyKeyRequiredProblem();
    }
    const fingerprint = this.idempotency.fingerprint({ jobId, templateItemId, ...dto });
    const replay = await this.idempotency.checkReplay(
      params.idempotencyKey,
      fingerprint,
      actor.actorId,
    );
    if (replay) {
      return replay.body as ItemResult;
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertJobWritable(job.status);
    this.assertIfMatch(job.draftVersion, params.ifMatch);

    const item = job.templateRevision.items.find((i) => i.id === templateItemId);
    if (!item) {
      throw notFoundProblem('Template item', templateItemId);
    }

    const existing = job.itemResults.find((r) => r.templateItemId === templateItemId);
    const now = new Date();
    const clientRecordedAt = dto.clientRecordedAt ? new Date(dto.clientRecordedAt) : now;

    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.itemResult.upsert({
        where: { jobId_templateItemId: { jobId, templateItemId } },
        update: {
          status: ITEM_STATUS_TO_DB[dto.status],
          remark: dto.remark ?? null,
          clientRecordedAt,
          recordedAt: now,
          recordedBy: actor.actorId,
        },
        create: {
          jobId,
          templateItemId,
          status: ITEM_STATUS_TO_DB[dto.status],
          remark: dto.remark ?? null,
          clientRecordedAt,
          recordedAt: now,
          recordedBy: actor.actorId,
        },
      });

      await this.transitionToInProgress(tx, job.id, job.status);

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: existing ? AuditActionT.update : AuditActionT.create,
        entityType: 'item_result',
        entityId: row.id,
        before: existing ? { status: existing.status } : null,
        after: { status: row.status, remark: row.remark },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      const dtoOut = toItemResult(row);
      await this.idempotency.recordWithin(
        tx,
        {
          key: params.idempotencyKey!,
          userId: actor.actorId,
          endpoint: 'PUT /jobs/{jobId}/items/{templateItemId}',
          fingerprint,
        },
        { status: 200, body: dtoOut },
      );

      return dtoOut;
    });

    return result;
  }

  async recordMeasurementResult(
    jobId: string,
    templateMeasurementId: string,
    dto: MeasurementResultInput,
    params: RecordResultParams,
    actor: ActorMeta,
    roles: string[],
  ): Promise<MeasurementResult> {
    if (!params.idempotencyKey) {
      throw idempotencyKeyRequiredProblem();
    }
    const fingerprint = this.idempotency.fingerprint({ jobId, templateMeasurementId, ...dto });
    const replay = await this.idempotency.checkReplay(
      params.idempotencyKey,
      fingerprint,
      actor.actorId,
    );
    if (replay) {
      return replay.body as MeasurementResult;
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertJobWritable(job.status);
    this.assertIfMatch(job.draftVersion, params.ifMatch);

    const measurement = job.templateRevision.measurements.find(
      (m) => m.id === templateMeasurementId,
    );
    if (!measurement) {
      throw notFoundProblem('Template measurement', templateMeasurementId);
    }

    const existing = job.measurementResults.find(
      (r) => r.templateMeasurementId === templateMeasurementId,
    );
    const now = new Date();
    const clientRecordedAt = dto.clientRecordedAt ? new Date(dto.clientRecordedAt) : now;

    const judgement = computeJudgement(
      {
        specType: SPEC_TYPE_FROM_DB[measurement.specType],
        lowerLimit: measurement.lowerLimit?.toNumber() ?? null,
        upperLimit: measurement.upperLimit?.toNumber() ?? null,
        nominal: measurement.nominal?.toNumber() ?? null,
        tolerance: measurement.tolerance?.toNumber() ?? null,
      },
      { readingNumeric: dto.readingNumeric ?? null, readingText: dto.readingText ?? null },
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.measurementResult.upsert({
        where: { jobId_templateMeasurementId: { jobId, templateMeasurementId } },
        update: {
          readingNumeric: dto.readingNumeric ?? null,
          readingText: dto.readingText ?? null,
          judgement: JUDGEMENT_TO_DB[judgement],
          remark: dto.remark ?? null,
          clientRecordedAt,
          recordedAt: now,
          recordedBy: actor.actorId,
        },
        create: {
          jobId,
          templateMeasurementId,
          readingNumeric: dto.readingNumeric ?? null,
          readingText: dto.readingText ?? null,
          judgement: JUDGEMENT_TO_DB[judgement],
          remark: dto.remark ?? null,
          clientRecordedAt,
          recordedAt: now,
          recordedBy: actor.actorId,
        },
      });

      await this.transitionToInProgress(tx, job.id, job.status);

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: existing ? AuditActionT.update : AuditActionT.create,
        entityType: 'measurement_result',
        entityId: row.id,
        before: existing ? { judgement: existing.judgement } : null,
        after: { judgement: row.judgement },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      const dtoOut = toMeasurementResult(row);
      await this.idempotency.recordWithin(
        tx,
        {
          key: params.idempotencyKey!,
          userId: actor.actorId,
          endpoint: 'PUT /jobs/{jobId}/measurements/{templateMeasurementId}',
          fingerprint,
        },
        { status: 200, body: dtoOut },
      );

      return dtoOut;
    });

    return result;
  }

  /** PR-API-18: `If-Match` is optional (see class doc) but enforced when the client sends it. */
  private assertIfMatch(currentDraftVersion: number, ifMatch: string | undefined): void {
    if (ifMatch === undefined) return;
    const expected = Number(ifMatch);
    if (Number.isNaN(expected) || expected !== currentDraftVersion) {
      throw draftConflictProblem(currentDraftVersion);
    }
  }

  /** PRD §5.1: `ASSIGNED -> IN_PROGRESS` on the first result recorded. Bumps `draftVersion` (PR-API-18). */
  private async transitionToInProgress(
    tx: Prisma.TransactionClient,
    jobId: string,
    currentStatus: JobStatusT,
  ): Promise<void> {
    await tx.job.update({
      where: { id: jobId },
      data: {
        status: currentStatus === JobStatusT.assigned ? JobStatusT.in_progress : undefined,
        startedAt: currentStatus === JobStatusT.assigned ? new Date() : undefined,
        draftVersion: { increment: 1 },
      },
    });
  }
}
