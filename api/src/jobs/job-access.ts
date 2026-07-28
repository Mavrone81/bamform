import { Injectable } from '@nestjs/common';
import { AreaScopeService } from '../common/area-scope';
import { forbiddenProblem, outOfScopeProblem } from '../common/domain-problems';

/**
 * API_SPECIFICATION.md §4.1 permission matrix:
 *   "View own assigned jobs"    — MAINTAINER, TEAM_LEADER, ENGINEER, ADMIN
 *   "View all jobs in scope"    — TEAM_LEADER, ENGINEER, DOC_CONTROLLER, ADMIN, AUDITOR
 *   "Record results / submit"  — MAINTAINER, TEAM_LEADER, ENGINEER
 * A role in `JOB_VIEW_ALL_ROLES` sees every job in their area scope; anyone
 * else (in practice, MAINTAINER) sees only jobs `assigned_to` them.
 * `JOB_RECORD_ROLES` gates the mutating endpoints via `@Roles()`.
 *
 * Slice 18-WORKFLOW ADDS `PLANNER` to `JOB_VIEW_ALL_ROLES` — additively, no
 * role is removed. This is not decoration: `assertAccessible` is what every
 * job mutation runs through, so without broad visibility a PLANNER holding
 * `@Roles('PLANNER', ...)` on `POST /jobs/{id}/assign` would still be
 * refused 403 ("You may only act on jobs assigned to you") on every job they
 * did not happen to be assigned — the role would be inert. A planner who
 * cannot see the work cannot plan it.
 *
 * Consequence, stated rather than hidden: `records.service.ts#hasBroadArchiveVisibility`
 * reuses this SAME constant, so PLANNER also gains "view all records in
 * scope" in the archive. That is a read of already-completed, area-scoped
 * work with no decrypted personal data on the path, and it is the natural
 * companion of planning; the alternative — a second, near-identical role
 * list — is how the two rules drift apart. See slice-18-workflow-report.md's
 * role matrix.
 */
export const JOB_VIEW_ALL_ROLES = [
  'PLANNER',
  'TEAM_LEADER',
  'ENGINEER',
  'DOC_CONTROLLER',
  'ADMIN',
  'AUDITOR',
];
export const JOB_RECORD_ROLES = ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'];

export interface JobAccessContext {
  userId: string;
  roles: string[];
}

export interface JobAccessSubject {
  assignedTo: string | null;
  areaId: string | null;
}

/**
 * Reusable job-level authorisation — area scoping (PR-API-10, ADR-005,
 * `AreaScopeService`) PLUS the role-driven "own vs all" visibility rule
 * above. Every job read/write handler (list, get, item/measurement/part/
 * attachment capture, submit, attachment fetch) goes through this so the
 * rule lives in one reviewable place, mirroring `AssetsService#assertInScope`.
 */
@Injectable()
export class JobAccessService {
  constructor(private readonly areaScope: AreaScopeService) {}

  hasBroadJobVisibility(roles: readonly string[]): boolean {
    return roles.some((role) => JOB_VIEW_ALL_ROLES.includes(role));
  }

  async getAllowedAreaIds(userId: string): Promise<string[] | null> {
    return this.areaScope.getAllowedAreaIds(userId);
  }

  /** Throws 403 `out-of-scope` (area) or 403 `forbidden` (not the assignee, no broad-visibility role). */
  async assertAccessible(actor: JobAccessContext, job: JobAccessSubject): Promise<void> {
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(actor.userId);
    if (allowedAreaIds !== null && (!job.areaId || !allowedAreaIds.includes(job.areaId))) {
      throw outOfScopeProblem('Job');
    }
    if (!this.hasBroadJobVisibility(actor.roles) && job.assignedTo !== actor.userId) {
      throw forbiddenProblem('You may only act on jobs assigned to you.');
    }
  }
}
