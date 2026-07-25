import { Injectable } from '@nestjs/common';
import type { Prisma, RecordExport } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateRecordExportInput {
  requestedBy: string;
  recordIds: readonly string[];
  requestedAt: Date;
}

/** Prisma CRUD for `record_export` (slice 12, PR-119) — used by BOTH the `api`-side request handler and the worker-side job processor. */
@Injectable()
export class RecordExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  createWithinTx(
    tx: Prisma.TransactionClient,
    input: CreateRecordExportInput,
  ): Promise<RecordExport> {
    return tx.recordExport.create({
      data: {
        requestedBy: input.requestedBy,
        status: 'pending',
        recordCount: input.recordIds.length,
        filterJson: { recordIds: [...input.recordIds] },
        requestedAt: input.requestedAt,
      },
    });
  }

  findById(id: string): Promise<RecordExport | null> {
    return this.prisma.recordExport.findUnique({ where: { id } });
  }

  markProcessing(id: string): Promise<RecordExport> {
    return this.prisma.recordExport.update({ where: { id }, data: { status: 'processing' } });
  }

  markDone(id: string, objectKey: string): Promise<RecordExport> {
    return this.prisma.recordExport.update({
      where: { id },
      data: { status: 'done', objectKey, completedAt: new Date() },
    });
  }

  markFailed(id: string, reason: string): Promise<RecordExport> {
    return this.prisma.recordExport.update({
      where: { id },
      data: { status: 'failed', failedReason: reason.slice(0, 2000), completedAt: new Date() },
    });
  }
}

/** `record_export.filter_json` always stores `{ recordIds: string[] }` (the resolved snapshot at request time — `records-export.service.ts`). */
export function recordIdsFromFilterJson(filterJson: unknown): string[] {
  if (
    filterJson &&
    typeof filterJson === 'object' &&
    Array.isArray((filterJson as { recordIds?: unknown }).recordIds)
  ) {
    return (filterJson as { recordIds: unknown[] }).recordIds.filter(
      (v): v is string => typeof v === 'string',
    );
  }
  return [];
}
