import { Injectable } from '@nestjs/common';
import { JobStatusT, type Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { JOB_SUMMARY_INCLUDE } from '../jobs/job-include';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A verifier's queue is bounded OPERATIONAL work — records currently
 * `SUBMITTED`, awaiting a decision — not an ever-growing archive (that's
 * `/records`, slice 12). This soft cap bounds the in-memory role/area
 * filtering `QueueService` does after this fetch (there is no single Prisma
 * query that can filter "does this job's CURRENT stage's role set intersect
 * this identity's roles" — `job.current_stage_ordinal` + `job.approval_route_id`
 * pair correlates against `approval_stage`'s composite key, which Prisma's
 * relational filters cannot express without a raw/correlated-subquery
 * escape hatch). If a deployment ever has more than this many jobs
 * genuinely awaiting verification at once, that is itself an operational
 * signal worth surfacing, not silently working around.
 */
const CANDIDATE_FETCH_CAP = 500;

/** One configured approval stage, as `getStageMap` returns it. */
export interface StageInfo {
  /** Role codes that satisfy this stage — ANY one of them (`approval_stage_role`). */
  roleCodes: string[];
  /** `approval_stage.label`, verbatim. */
  label: string;
  /** How many stages the OWNING ROUTE has, denormalised onto every stage. */
  stageCount: number;
}

/**
 * DB access for `GET /queue` (PR-073/076/081, UR-049) and the notification/
 * escalation recipient resolution (`VerifierEligibilityService`) — kept
 * separate from those services mirroring `jobs.repository.ts`'s split.
 */
@Injectable()
export class QueueRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every configured `approval_stage`, keyed `${approvalRouteId}:${stageOrdinal}`:
   * the role codes that satisfy it, its administrator-configured label, and
   * how many stages its route has. `approval_route`/`approval_stage` is
   * route-as-data (ADR-011) but a handful of rows in practice — one query,
   * reused across the caller's own eligibility check and every active
   * delegator's, rather than N+1 per job.
   *
   * `label`/`stageCount` are presentation (slice 26-TWOSTAGE: the queue must
   * say WHICH of the route's stages a record awaits) and ride along on the
   * same read rather than costing a second round trip to the same table.
   */
  async getStageMap(): Promise<Map<string, StageInfo>> {
    const stages = await this.prisma.approvalStage.findMany({
      include: { stageRoles: { include: { role: true } } },
    });
    const stageCountByRoute = new Map<string, number>();
    for (const stage of stages) {
      stageCountByRoute.set(
        stage.approvalRouteId,
        (stageCountByRoute.get(stage.approvalRouteId) ?? 0) + 1,
      );
    }
    const map = new Map<string, StageInfo>();
    for (const stage of stages) {
      map.set(`${stage.approvalRouteId}:${stage.stageOrdinal}`, {
        roleCodes: stage.stageRoles.map((stageRole) => stageRole.role.code),
        label: stage.label,
        stageCount: stageCountByRoute.get(stage.approvalRouteId) ?? 1,
      });
    }
    return map;
  }

  /** A user's role codes, read fresh from the DB — never trusted from a JWT for anyone but the CALLER (`AccessTokenClaims.roles` only covers the caller; a delegator's roles must be looked up). */
  async getUserRoleCodes(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    return rows.map((row) => row.role.code);
  }

  /** Distinct user ids holding ANY of `roleCodes` — the candidate recipient set before area-scope filtering. */
  async findUserIdsWithRoles(roleCodes: string[]): Promise<string[]> {
    if (roleCodes.length === 0) return [];
    const rows = await this.prisma.userRole.findMany({
      where: { role: { code: { in: roleCodes } } },
      select: { userId: true },
    });
    return [...new Set(rows.map((row) => row.userId))];
  }

  /**
   * `SUBMITTED` jobs not submitted by `excludeSubmittedBy` (PR-073: "is not
   * the submitter"), area-scoped to `allowedAreaIds` (PR-API-10). Role/stage
   * eligibility is NOT filtered here (see class doc comment) — the caller
   * (`QueueService`) filters the returned rows by role after this fetch.
   */
  findCandidateSubmittedJobs(
    excludeSubmittedBy: string,
    allowedAreaIds: string[] | null,
    take: number = CANDIDATE_FETCH_CAP,
  ) {
    const assetScope = applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds);
    return this.prisma.job.findMany({
      where: {
        status: JobStatusT.submitted,
        submittedBy: { not: excludeSubmittedBy },
        asset: Object.keys(assetScope).length > 0 ? assetScope : undefined,
      },
      include: JOB_SUMMARY_INCLUDE,
      orderBy: { id: 'asc' },
      take,
    });
  }
}
