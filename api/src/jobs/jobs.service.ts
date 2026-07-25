import { Injectable } from '@nestjs/common';
import type { Job, JobSummary } from '@bamform/shared';
import { notFoundProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { JOB_STATUS_TO_DB } from './job-enums';
import { JobAccessService } from './job-access';
import { JobsRepository } from './jobs.repository';
import { toJob, toJobSummary } from './mappers';

export interface ListJobsParams {
  limit?: unknown;
  cursor?: string;
  status?: string;
  assignedTo?: string;
  assetId?: string;
  overdue?: boolean;
  dueFrom?: string;
  dueTo?: string;
}

/**
 * PR-030 — job read/list. Deliverable 1 of slice 6: "list assigned/overdue
 * (overdue DERIVED not stored — non-negotiable #12), get one job with its
 * frozen revision's checklist items + measurements (active only) and any
 * recorded results."
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly repo: JobsRepository,
    private readonly access: JobAccessService,
  ) {}

  async list(userId: string, roles: string[], params: ListJobsParams): Promise<Page<JobSummary>> {
    const limit = normaliseLimit(params.limit);
    const allowedAreaIds = await this.access.getAllowedAreaIds(userId);
    // MAINTAINER (no broad-visibility role) sees only jobs assigned to them
    // (API_SPECIFICATION.md §4.1 "View own assigned jobs" vs "View all jobs
    // in scope") — enforced here, not left to the client to filter (PR-007).
    const restrictToAssignee = this.access.hasBroadJobVisibility(roles) ? null : userId;

    const rows = await this.repo.findMany(
      {
        status: params.status
          ? JOB_STATUS_TO_DB[params.status as keyof typeof JOB_STATUS_TO_DB]
          : undefined,
        assignedTo: params.assignedTo,
        assetId: params.assetId,
        dueFrom: params.dueFrom,
        dueTo: params.dueTo,
        overdue: params.overdue,
        afterId: decodeCursor(params.cursor),
        take: limit + 1,
      },
      allowedAreaIds,
      restrictToAssignee,
    );

    const page = paginate(rows, limit);
    return { data: page.data.map((row) => toJobSummary(row)), page: page.page };
  }

  async get(userId: string, roles: string[], id: string): Promise<Job> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw notFoundProblem('Job', id);
    }
    await this.access.assertAccessible(
      { userId, roles },
      { assignedTo: row.assignedTo, areaId: row.asset.areaId },
    );
    return toJob(row);
  }

  /** Internal helper other job services (results/parts/attachments/submission) share for the access + status guard. */
  async loadForMutation(userId: string, roles: string[], id: string) {
    const row = await this.repo.findById(id);
    if (!row) {
      throw notFoundProblem('Job', id);
    }
    await this.access.assertAccessible(
      { userId, roles },
      { assignedTo: row.assignedTo, areaId: row.asset.areaId },
    );
    return row;
  }
}
