import { Injectable } from '@nestjs/common';
import type { JobStatusT, Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_SUMMARY_INCLUDE, JOB_FULL_INCLUDE } from './job-include';

export interface JobListFilters {
  status?: JobStatusT;
  assignedTo?: string;
  assetId?: string;
  dueFrom?: string;
  dueTo?: string;
  overdue?: boolean;
  afterId?: string;
  take: number;
}

/**
 * Repository layer for `job` — PR-API-10/ADR-005's mandatory area scoping,
 * following the reference pattern `assets.repository.ts` (slice 4)
 * established: EVERY collection read goes through `findMany`, which always
 * applies `applyAreaScope` before the query runs. `job` has no `areaId`
 * column of its own (DBD §6.15) — the scope lives on `job.asset.areaId`, so
 * the filter is nested under the `asset` relation rather than a bare column.
 *
 * The "own jobs only" restriction (`JOB_VIEW_ALL_ROLES`, `job-access.ts`) is
 * a ROLE rule, not an area rule, and is applied by the caller via
 * `restrictToAssignee` — kept as a separate, explicit parameter here (not
 * folded into `allowedAreaIds`) so the two orthogonal mechanisms (area scope
 * vs. role-driven ownership) stay independently readable/testable.
 */
@Injectable()
export class JobsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(
    filters: JobListFilters,
    allowedAreaIds: string[] | null,
    restrictToAssignee: string | null,
    today: Date = new Date(),
  ) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds);

    const andConditions: Prisma.JobWhereInput[] = [];
    const dueOnFilter = buildDueOnFilter(filters.dueFrom, filters.dueTo);
    if (dueOnFilter) andConditions.push({ dueOn: dueOnFilter });
    if (filters.overdue) andConditions.push(overdueWhere(today));

    const where: Prisma.JobWhereInput = {
      status: filters.status,
      assetId: filters.assetId,
      assignedTo: restrictToAssignee ?? filters.assignedTo,
      id: filters.afterId ? { gt: filters.afterId } : undefined,
      asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      AND: andConditions.length > 0 ? andConditions : undefined,
    };

    return this.prisma.job.findMany({
      where,
      include: JOB_SUMMARY_INCLUDE,
      orderBy: { id: 'asc' },
      take: filters.take,
    });
  }

  findById(id: string) {
    return this.prisma.job.findUnique({ where: { id }, include: JOB_FULL_INCLUDE });
  }

  findByIdForAccess(id: string) {
    return this.prisma.job.findUnique({
      where: { id },
      select: { id: true, assignedTo: true, asset: { select: { areaId: true } } },
    });
  }

  /**
   * `GET /sync/bootstrap` (PR-API-22/PR-059) — the SAME area+assignee scope
   * `findMany` applies above, but with `JOB_FULL_INCLUDE` (the frozen
   * revision + all current results, slice 6's `toJob`) so the device can
   * render every returned job offline with no further call, batched in ONE
   * query rather than N `findById` round-trips per job.
   *
   * `since`, when supplied, restricts to jobs that plausibly changed: the
   * job's own lifecycle timestamps, OR any child row (result/part/
   * attachment/approval-step) recorded since then. `job.updatedAt` is
   * deliberately NOT used — no model in this schema sets `@updatedAt`
   * (checked: none of the 20-odd models do), so it would only reflect
   * row-creation time and silently miss "a result was recorded on an
   * existing job", which is precisely PR-059's "any draft results already
   * recorded" case. Introducing `@updatedAt` for `Job` alone would be a
   * schema-convention change wider than this slice's mandate — see
   * slice-9-report.md.
   */
  findManyFull(allowedAreaIds: string[] | null, restrictToAssignee: string | null, since?: Date) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds);

    const where: Prisma.JobWhereInput = {
      assignedTo: restrictToAssignee ?? undefined,
      asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      OR: since ? sinceOrConditions(since) : undefined,
    };

    return this.prisma.job.findMany({
      where,
      include: JOB_FULL_INCLUDE,
      orderBy: { id: 'asc' },
    });
  }
}

/** PR-059 "any draft results already recorded" — see `findManyFull`'s header. */
function sinceOrConditions(since: Date): Prisma.JobWhereInput[] {
  return [
    { generatedAt: { gte: since } },
    { startedAt: { gte: since } },
    { submittedAt: { gte: since } },
    { verifiedAt: { gte: since } },
    { archivedAt: { gte: since } },
    { itemResults: { some: { recordedAt: { gte: since } } } },
    { measurementResults: { some: { recordedAt: { gte: since } } } },
    // Mirrors the createdAt/recordedAt pattern above, so a soft-remove or
    // edit (which only touches updatedAt) doesn't re-trigger this delta —
    // a removed part can linger on another device until some other change
    // re-sends the job. Not a signing-integrity concern: the server always
    // reads the active:true-filtered set when assembling a record.
    { partsUsed: { some: { createdAt: { gte: since } } } },
    { attachments: { some: { uploadedAt: { gte: since } } } },
    { approvalSteps: { some: { actedAt: { gte: since } } } },
  ];
}

function buildDueOnFilter(dueFrom?: string, dueTo?: string): Prisma.DateTimeFilter | undefined {
  if (!dueFrom && !dueTo) return undefined;
  return {
    gte: dueFrom ? new Date(dueFrom) : undefined,
    lte: dueTo ? new Date(dueTo) : undefined,
  };
}

/**
 * PR-043: `due_on < today AND status NOT IN (VERIFIED, ARCHIVED, VOIDED)` —
 * mirrors `overdue.ts#isOverdue`. Exported (slice 12) so
 * `reports.repository.ts#/reports/overdue` reuses the EXACT SAME
 * derivation rather than a second, potentially-drifting copy of "what
 * counts as overdue" (PR-043/BUILD_HANDOFF non-negotiable #12: "Overdue is
 * derived, never stored").
 */
export function overdueWhere(today: Date): Prisma.JobWhereInput {
  const dateOnly = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  return {
    dueOn: { lt: dateOnly },
    status: { notIn: ['verified', 'archived', 'voided'] },
  };
}
