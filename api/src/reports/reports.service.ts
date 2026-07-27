import { Injectable } from '@nestjs/common';
import type {
  ComplianceReport,
  ComplianceReportQuery,
  MeasurementTrend,
  MeasurementTrendQuery,
  OverdueReport,
  PendingReport,
} from '@bamform/shared';
import { AreaScopeService } from '../common/area-scope';
import { notFoundProblem, outOfScopeProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate } from '../common/pagination';
import { toJobSummary } from '../jobs/mappers';
import { PrismaService } from '../prisma/prisma.service';
import { hasBroadArchiveVisibility } from '../records/records.service';
import { ReportsRepository } from './reports.repository';

const DEFAULT_COMPLIANCE_WINDOW_DAYS = 90;

@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly areaScope: AreaScopeService,
    private readonly prisma: PrismaService,
  ) {}

  /** UR-070 — readings are cleartext by design (ADR-004), so this trend is a direct SQL/Prisma aggregation, no decrypt. */
  async measurementTrend(userId: string, query: MeasurementTrendQuery): Promise<MeasurementTrend> {
    const asset = await this.prisma.asset.findUnique({
      where: { id: query.assetId },
      select: { id: true, code: true, areaId: true },
    });
    if (!asset) {
      throw notFoundProblem('Asset', query.assetId);
    }
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    if (allowedAreaIds !== null && (!asset.areaId || !allowedAreaIds.includes(asset.areaId))) {
      throw outOfScopeProblem('Asset');
    }

    const rows = await this.repo.findMeasurementTrend(
      query.assetId,
      query.stableKey,
      query.from,
      query.to,
    );

    const first = rows[0]?.templateMeasurement;
    return {
      assetCode: asset.code,
      stableKey: query.stableKey,
      description: first?.description,
      unit: first?.unit ?? null,
      lowerLimit: first?.lowerLimit ? first.lowerLimit.toNumber() : null,
      upperLimit: first?.upperLimit ? first.upperLimit.toNumber() : null,
      points: rows.map((r) => ({
        recordId: r.jobId,
        performedOn: r.recordedAt.toISOString().slice(0, 10),
        revisionCode: r.job.templateRevision.revisionCode,
        reading: r.readingNumeric ? r.readingNumeric.toNumber() : null,
        judgement:
          r.judgement === 'pass' ? 'PASS' : r.judgement === 'fail' ? 'FAIL' : 'NOT_EVALUATED',
      })),
    };
  }

  /** UR-068 — currently overdue, scoped exactly like `GET /jobs?overdue=true` (`JobAccessService`'s own broad-vs-own rule, reused via `hasBroadArchiveVisibility`). */
  async overdue(
    userId: string,
    roles: string[],
    limit: unknown,
    cursor?: string,
  ): Promise<OverdueReport> {
    const take = normaliseLimit(limit);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    const restrictToAssignee = hasBroadArchiveVisibility(roles) ? null : userId;
    const rows = await this.repo.findOverdue(
      allowedAreaIds,
      restrictToAssignee,
      take + 1,
      decodeCursor(cursor),
    );
    return paginate(
      rows.map((row) => toJobSummary(row)),
      take,
    );
  }

  /** UR-068 — submitted-but-unverified, with ageing. */
  async pending(
    userId: string,
    roles: string[],
    limit: unknown,
    cursor?: string,
  ): Promise<PendingReport> {
    const take = normaliseLimit(limit);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    const restrictToAssignee = hasBroadArchiveVisibility(roles) ? null : userId;
    const rows = await this.repo.findPendingVerification(
      allowedAreaIds,
      restrictToAssignee,
      take + 1,
      decodeCursor(cursor),
    );
    const now = new Date();
    return paginate(
      rows.map((row) => {
        if (!row.submittedAt) {
          throw new Error(
            `Job ${row.id} appears in the pending-verification report but has no submittedAt`,
          );
        }
        return {
          ...toJobSummary(row, now),
          submittedAt: row.submittedAt.toISOString(),
          ageHours: Math.round(((now.getTime() - row.submittedAt.getTime()) / 3_600_000) * 10) / 10,
        };
      }),
      take,
    );
  }

  /**
   * UR-067 — due vs. completed on time, grouped by area. "On time" =
   * archived at or before the due date; everything else in the window
   * (still open, or not yet due) counts as not-completed — except VOIDED
   * rows, which are excluded from the aggregation entirely (slice 17 review
   * V-1: a voided period regenerates, so counting the voided row in any
   * bucket double-counts the period; see the loop comment).
   * SIMPLIFICATION, documented rather than hidden: a job due
   * later in the window than "now" but not yet actioned is counted as
   * not-completed even though it hasn't failed anything yet (it just hasn't
   * happened); this keeps the aggregation a single pass with no "is this
   * due date in the future" branch. Acceptable for a reporting surface
   * (UR-067) that is not itself compliance-gating; call out if a stricter
   * split (not-yet-due vs. genuinely missed) is wanted later.
   */
  async compliance(userId: string, query: ComplianceReportQuery): Promise<ComplianceReport> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_COMPLIANCE_WINDOW_DAYS * 24 * 3_600_000);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);

    if (query.areaId && allowedAreaIds !== null && !allowedAreaIds.includes(query.areaId)) {
      throw outOfScopeProblem('Area');
    }

    const rows = await this.repo.findDueInRangeForCompliance(
      from,
      to,
      allowedAreaIds,
      query.areaId,
    );

    const byArea = new Map<
      string,
      {
        areaId: string | null;
        areaCode: string | null;
        due: number;
        onTime: number;
        late: number;
        notCompleted: number;
      }
    >();
    for (const row of rows) {
      // Slice 17-VOID (review V-1): a voided row is EXCLUDED from the
      // aggregation entirely — the owner's rule is "the schedule behaves as
      // if that PM never happened", and since slice 17 a voided period
      // REGENERATES, so one logical period can be two rows (the voided one +
      // its replacement). Counting the voided row at all — as due, completed
      // OR notCompleted — double-counts the period forever (proved in
      // I-VOID-12: due=2/completed=1/notCompleted=1 for one fully-completed
      // period). The replacement row represents the period; between the void
      // and the next tick the period is simply absent, faithful to "never
      // happened". Note a post-archive-voided row keeps its untouched
      // `archived_at`, so the status check (not the timestamp) is the guard.
      if (row.status === 'voided') {
        continue;
      }
      const key = row.asset.areaId ?? '__none__';
      const bucket = byArea.get(key) ?? {
        areaId: row.asset.areaId,
        areaCode: row.asset.area?.code ?? null,
        due: 0,
        onTime: 0,
        late: 0,
        notCompleted: 0,
      };
      bucket.due += 1;
      if (row.archivedAt) {
        if (row.archivedAt.getTime() <= row.dueOn.getTime()) bucket.onTime += 1;
        else bucket.late += 1;
      } else {
        // Still open (overdue-and-incomplete as of `now`) — not completed for this period.
        bucket.notCompleted += 1;
      }
      byArea.set(key, bucket);
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      rows: [...byArea.values()].map((b) => ({
        areaId: b.areaId,
        areaCode: b.areaCode,
        dueCount: b.due,
        completedOnTimeCount: b.onTime,
        completedLateCount: b.late,
        notCompletedCount: b.notCompleted,
        compliancePercent: b.due > 0 ? Math.round((b.onTime / b.due) * 1000) / 10 : 0,
      })),
    };
  }
}
