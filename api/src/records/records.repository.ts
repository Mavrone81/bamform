import { Injectable } from '@nestjs/common';
import { ApprovalActionT, type Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { JOB_FULL_INCLUDE, JOB_SUMMARY_INCLUDE } from '../jobs/job-include';
import { PrismaService } from '../prisma/prisma.service';

/**
 * UR-058 — "search and filter the archive by asset, asset type, document
 * number, frequency, date range, technician and approver." An archived
 * record IS a `job` row with `status = archived` (`records.controller.ts`'s
 * established convention — no separate `record` table). Mirrors
 * `jobs.repository.ts`'s area-scope/pagination pattern exactly rather than
 * reimplementing it — `GET /records` and `GET /jobs` are the same
 * underlying table, filtered by a different, archive-specific query shape.
 */
export interface RecordListFilters {
  assetId?: string;
  assetTypeId?: string;
  documentNumber?: string;
  frequency?: 'M1' | 'M3' | 'M6' | 'Y';
  archivedFrom?: string;
  archivedTo?: string;
  technician?: string;
  approver?: string;
  /**
   * Slice 17-VOID: `undefined` (default) → the WHOLE archive, voided-archived
   * records INCLUDED (an auditor must see voids, not lose them); `true` →
   * only voided-archived; `false` → only live archived records.
   */
  voided?: boolean;
  afterId?: string;
  /** `POST /records/export`'s explicit `recordIds` selection (`records-export.service.ts`) — re-validated against area/role scope like every other filter here, never trusted bare. */
  ids?: string[];
  take: number;
}

@Injectable()
export class RecordsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(
    filters: RecordListFilters,
    allowedAreaIds: string[] | null,
    restrictToAssignee: string | null,
  ) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>(
      filters.assetTypeId ? { assetTypeId: filters.assetTypeId } : {},
      allowedAreaIds,
    );

    const archivedAtFilter = buildArchivedAtFilter(filters.archivedFrom, filters.archivedTo);

    const where: Prisma.JobWhereInput = {
      // Slice 17-VOID — "an archived record IS a job row with status =
      // archived" grows one sibling: a job voided AFTER archive keeps its
      // full double-signed record (`archived_at` remains set on the
      // untouched row) and stays part of the archive, annotated VOIDED.
      // Pre-archive voids (never verified, `archived_at IS NULL`) are NOT
      // archive records and stay out, exactly as before.
      AND: [archiveStatusWhere(filters.voided)],
      assetId: filters.assetId,
      frequency: filters.frequency,
      assignedTo: restrictToAssignee ?? undefined,
      submittedBy: filters.technician,
      archivedAt: archivedAtFilter,
      id: filters.ids ? { in: filters.ids } : filters.afterId ? { gt: filters.afterId } : undefined,
      asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      templateRevision: filters.documentNumber
        ? { formTemplate: { documentNumber: filters.documentNumber } }
        : undefined,
      approvalSteps: filters.approver
        ? { some: { actorId: filters.approver, action: ApprovalActionT.verified } }
        : undefined,
    };

    return this.prisma.job.findMany({
      where,
      include: JOB_SUMMARY_INCLUDE,
      orderBy: { id: 'asc' },
      take: filters.take,
    });
  }

  /** Resolves a filter set to a bare list of record ids — used to snapshot an export request (`records-export.service.ts`) without the SUMMARY include's extra joins. */
  async findIds(
    filters: Omit<RecordListFilters, 'afterId' | 'take'>,
    allowedAreaIds: string[] | null,
    restrictToAssignee: string | null,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.findMany(
      { ...filters, take: limit },
      allowedAreaIds,
      restrictToAssignee,
    );
    return rows.map((r) => r.id);
  }

  findByIdForRecord(id: string) {
    return this.prisma.job.findFirst({
      where: { id, AND: [archiveStatusWhere(undefined)] },
      include: JOB_FULL_INCLUDE,
    });
  }
}

/** Slice 17-VOID — see `RecordListFilters.voided`. */
function archiveStatusWhere(voided: boolean | undefined): Prisma.JobWhereInput {
  if (voided === true) {
    return { status: 'voided', archivedAt: { not: null } };
  }
  if (voided === false) {
    return { status: 'archived' };
  }
  return { OR: [{ status: 'archived' }, { status: 'voided', archivedAt: { not: null } }] };
}

function buildArchivedAtFilter(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    gte: from ? new Date(from) : undefined,
    lte: to ? new Date(to) : undefined,
  };
}
