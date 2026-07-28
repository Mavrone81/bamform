import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { JOB_SUMMARY_INCLUDE } from '../jobs/job-include';
import { overdueWhere } from '../jobs/jobs.repository';
import { PrismaService } from '../prisma/prisma.service';

/**
 * UR-067..070/PRD §9 report surface. Deliberately plain Prisma
 * query-builder calls (no raw SQL — this codebase has none anywhere;
 * `/reports/measurements` joins `measurement_result -> template_measurement
 * -> job` by `stableKey`/`assetId`, which Prisma's relation filters express
 * directly) rather than the DB-role-specific concerns `bamform_readonly`
 * (PR-API-09) would otherwise need raw SQL to reach — none of these reports
 * need that role distinction, they run under the caller's normal `api`
 * connection like every other read path.
 */
@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** UR-070 — trend series for one measurement identity (`stableKey`) on one asset, across revisions. Readings are cleartext BY DESIGN (ADR-004) so this aggregates directly in SQL/Prisma, no application-side decrypt. */
  findMeasurementTrend(assetId: string, stableKey: string, from?: string, to?: string) {
    return this.prisma.measurementResult.findMany({
      where: {
        templateMeasurement: { stableKey },
        job: {
          assetId,
          status: { in: ['verified', 'archived'] },
          ...(from || to
            ? {
                dueOn: {
                  gte: from ? new Date(from) : undefined,
                  lte: to ? new Date(to) : undefined,
                },
              }
            : {}),
        },
      },
      include: {
        templateMeasurement: true,
        job: { include: { templateRevision: true, asset: true } },
      },
      orderBy: { recordedAt: 'asc' },
    });
  }

  /** UR-068 — jobs currently overdue (derived, PR-043), scoped. */
  findOverdue(
    allowedAreaIds: string[] | null,
    restrictToAssignee: string | null,
    take: number,
    afterId?: string,
    today: Date = new Date(),
  ) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds);
    return this.prisma.job.findMany({
      where: {
        ...overdueWhere(today),
        assignedTo: restrictToAssignee ?? undefined,
        id: afterId ? { gt: afterId } : undefined,
        asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      },
      include: JOB_SUMMARY_INCLUDE,
      orderBy: { id: 'asc' },
      take,
    });
  }

  /** UR-068 — submitted jobs awaiting verification, with ageing. */
  findPendingVerification(
    allowedAreaIds: string[] | null,
    restrictToAssignee: string | null,
    take: number,
    afterId?: string,
  ) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds);
    return this.prisma.job.findMany({
      where: {
        status: 'submitted',
        assignedTo: restrictToAssignee ?? undefined,
        id: afterId ? { gt: afterId } : undefined,
        asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      },
      include: JOB_SUMMARY_INCLUDE,
      orderBy: { id: 'asc' },
      take,
    });
  }

  /**
   * UR-067 — every job due in [from, to], scoped, WITH its area code and
   * verification timing, for in-process aggregation
   * (`reports.service.ts#compliance`). Report-scale data (PRD: ~1,500
   * records/year) — no need for DB-side GROUP BY.
   *
   * Deliberately returns AD-HOC rows too, with `isAdhoc` selected, rather
   * than filtering them in SQL: the service excludes them from every
   * compliance bucket AND reports how many it excluded, so the number is
   * visibly "compliance against the plan", not silently a different
   * population than the caller asked for (slice 18-WORKFLOW review, X-4 —
   * same shape as slice 17's voided-row exclusion).
   */
  findDueInRangeForCompliance(
    from: Date,
    to: Date,
    allowedAreaIds: string[] | null,
    areaId?: string,
  ) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>(
      areaId ? { areaId } : {},
      allowedAreaIds,
    );
    return this.prisma.job.findMany({
      where: {
        dueOn: { gte: from, lte: to },
        asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      },
      select: {
        id: true,
        dueOn: true,
        status: true,
        submittedAt: true,
        archivedAt: true,
        voidReason: true,
        // Slice 18-WORKFLOW review, finding X-4 — the aggregation must be
        // able to tell PLANNED work from off-plan work (`reports.service.ts`).
        isAdhoc: true,
        asset: { select: { areaId: true, area: { select: { code: true } } } },
      },
    });
  }
}
