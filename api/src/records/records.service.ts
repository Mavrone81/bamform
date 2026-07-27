import { Injectable } from '@nestjs/common';
import type { Job, JobSummary, ListRecordsQuery } from '@bamform/shared';
import { AreaScopeService } from '../common/area-scope';
import { notFoundProblem, outOfScopeProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { JOB_VIEW_ALL_ROLES } from '../jobs/job-access';
import { toJob, toJobSummary } from '../jobs/mappers';
import { RecordsRepository } from './records.repository';

/**
 * UR-055/058 — the read side of the archive. Reuses `JOB_VIEW_ALL_ROLES`
 * (`job-access.ts`) unchanged: API_SPECIFICATION.md §4.1's "View archive"
 * row grants MAINTAINER only their OWN records and everyone in
 * `JOB_VIEW_ALL_ROLES` every record in area scope — the EXACT SAME
 * broad-vs-own split `JobAccessService` already establishes for live jobs,
 * not a new rule invented for the archive.
 */
@Injectable()
export class RecordsService {
  constructor(
    private readonly repo: RecordsRepository,
    private readonly areaScope: AreaScopeService,
  ) {}

  async list(userId: string, roles: string[], query: ListRecordsQuery): Promise<Page<JobSummary>> {
    const limit = normaliseLimit(query.limit);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    const restrictToAssignee = hasBroadArchiveVisibility(roles) ? null : userId;

    const rows = await this.repo.findMany(
      {
        assetId: query.assetId,
        assetTypeId: query.assetTypeId,
        documentNumber: query.documentNumber,
        frequency: query.frequency,
        archivedFrom: query.archivedFrom,
        archivedTo: query.archivedTo,
        technician: query.technician,
        approver: query.approver,
        voided: query.voided,
        afterId: decodeCursor(query.cursor),
        take: limit + 1,
      },
      allowedAreaIds,
      restrictToAssignee,
    );

    return paginate(
      rows.map((row) => toJobSummary(row)),
      limit,
    );
  }

  async getById(userId: string, roles: string[], recordId: string): Promise<Job> {
    const row = await this.repo.findByIdForRecord(recordId);
    if (!row) {
      throw notFoundProblem('Record', recordId);
    }
    await this.assertAccessible(userId, roles, row.asset.areaId, row.assignedTo);
    return toJob(row);
  }

  /** Shared by `getById` and the PDF/export paths — same "own vs. all in scope" rule `JobAccessService` applies to live jobs. */
  async assertAccessible(
    userId: string,
    roles: string[],
    areaId: string | null,
    assignedTo: string | null,
  ): Promise<void> {
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    if (allowedAreaIds !== null && (!areaId || !allowedAreaIds.includes(areaId))) {
      throw outOfScopeProblem('Record');
    }
    if (!hasBroadArchiveVisibility(roles) && assignedTo !== userId) {
      throw outOfScopeProblem('Record');
    }
  }
}

export function hasBroadArchiveVisibility(roles: readonly string[]): boolean {
  return roles.some((role) => JOB_VIEW_ALL_ROLES.includes(role));
}
