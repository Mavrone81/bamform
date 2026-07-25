import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { AuditActionT } from '@prisma/client';
import type { RecordExportRequest, RecordExportStatusResponse } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { AreaScopeService } from '../common/area-scope';
import {
  forbiddenProblem,
  notFoundProblem,
  validationFailedProblem,
} from '../common/domain-problems';
import { hasBroadArchiveVisibility } from '../records/records.service';
import { RecordsRepository } from '../records/records.repository';
import { PdfQueueService } from '../pdf/pdf-queue.service';
import { MinioService } from '../storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecordExportRepository } from './record-export.repository';
import { toRecordExportStatusResponse } from './record-export.mapper';

/** P-09's benchmark is "bulk export of 100 records" — bounded well above that so a legitimate DMS-filing run isn't capped, while still bounding worst-case memory (PR-ENV-13's concern extends to the export job, which renders many PDFs in one BullMQ job). */
const EXPORT_MAX_RECORDS = 500;

/**
 * `api`-side of `POST /records/export` / `GET /exports/{id}` (PR-119). The
 * FILTER (or explicit `recordIds`) is resolved to a concrete, scoped list of
 * record ids ONCE, here, using the caller's OWN area/role scope
 * (`RecordsRepository`/`AreaScopeService` — the exact same mechanism `GET
 * /records` uses) and that snapshot is what the worker acts on
 * (`records.repository.ts`'s `ids` filter re-validates even an explicit
 * `recordIds` selection against scope, so a caller cannot smuggle in a
 * record outside their own visibility by id).
 */
@Injectable()
export class RecordsExportService {
  constructor(
    private readonly recordsRepo: RecordsRepository,
    private readonly areaScope: AreaScopeService,
    private readonly exportRepo: RecordExportRepository,
    private readonly pdfQueue: PdfQueueService,
    private readonly minio: MinioService,
    private readonly audit: AuditEventService,
    private readonly prisma: PrismaService,
  ) {}

  async requestExport(
    actor: ActorMeta,
    roles: string[],
    request: RecordExportRequest,
  ): Promise<RecordExportStatusResponse> {
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(actor.actorId);
    const restrictToAssignee = hasBroadArchiveVisibility(roles) ? null : actor.actorId;

    const recordIds =
      request.recordIds && request.recordIds.length > 0
        ? await this.recordsRepo.findIds(
            { ids: request.recordIds },
            allowedAreaIds,
            restrictToAssignee,
            EXPORT_MAX_RECORDS + 1,
          )
        : await this.recordsRepo.findIds(
            request.filters ?? {},
            allowedAreaIds,
            restrictToAssignee,
            EXPORT_MAX_RECORDS + 1,
          );

    if (recordIds.length === 0) {
      throw validationFailedProblem(
        'No archived records matched this export request (either none exist, or they are outside your scope).',
      );
    }
    if (recordIds.length > EXPORT_MAX_RECORDS) {
      throw validationFailedProblem(
        `This export would include more than ${EXPORT_MAX_RECORDS} records — narrow the filter (e.g. a shorter date range).`,
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await this.exportRepo.createWithinTx(tx, {
        requestedBy: actor.actorId,
        recordIds,
        requestedAt: new Date(),
      });
      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.exportAction,
        entityType: 'record_export',
        entityId: created.id,
        after: { recordCount: recordIds.length },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });
      return created;
    });

    await this.pdfQueue.enqueueExport({ exportId: row.id });

    return toRecordExportStatusResponse(row);
  }

  /** `GET /exports/{id}` — authorised to the REQUESTER only (an export snapshot may contain records outside the requester's CURRENT scope if their access later narrows; only the person who asked for it may poll/download it). */
  async getStatus(exportId: string, actor: ActorMeta): Promise<RecordExportStatusResponse> {
    const row = await this.exportRepo.findById(exportId);
    if (!row) {
      throw notFoundProblem('Export', exportId);
    }
    if (row.requestedBy !== actor.actorId) {
      throw forbiddenProblem('You may only view an export you requested.');
    }
    return toRecordExportStatusResponse(row);
  }

  /** `GET /exports/{id}/download` — ADR-007: streamed through `api`, authorised on EVERY fetch, never a presigned URL. */
  async download(exportId: string, actor: ActorMeta): Promise<StreamableFile> {
    const row = await this.exportRepo.findById(exportId);
    if (!row) {
      throw notFoundProblem('Export', exportId);
    }
    if (row.requestedBy !== actor.actorId) {
      throw forbiddenProblem('You may only download an export you requested.');
    }
    if (row.status !== 'done' || !row.objectKey) {
      throw new NotFoundException({
        type: '/errors/not-found',
        title: 'Not found',
        status: 404,
        detail: `Export ${exportId} is not ready yet (status: ${row.status}).`,
      });
    }
    const stream: Readable = await this.minio.getObjectStream(row.objectKey);
    return new StreamableFile(stream, {
      type: 'application/zip',
      disposition: `attachment; filename="export-${exportId}.zip"`,
    });
  }
}
