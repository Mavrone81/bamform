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
 * ############################################################################
 * THIS CONSTANT IS AN ACCESS PREDICATE, NOT A ROUTE-ANNOTATION LIST.
 *
 * Use it for `JobAccessService#assertAccessible` and
 * `records.service.ts#hasBroadArchiveVisibility` — the "can this caller see
 * THIS row" question, evaluated per row, after area scoping.
 *
 * Do NOT spread it into `@Roles(...)`. That is how slice 18's review found
 * finding X-1 (Critical): adding PLANNER here silently granted it
 * `POST /records/export`, `GET /exports/{id}`, `GET /exports/{id}/download`
 * and all four `/reports/*` endpoints, because those routes annotated
 * themselves with `@Roles(...JOB_VIEW_ALL_ROLES)`. Measured: PLANNER reached
 * `GET /reports/compliance` 200 where MAINTAINER got 403 — and the export
 * path renders PDFs through `pdf-record-assembly.service.ts`, which DECRYPTS
 * signatory full names and drawn-signature images. A planning role was one
 * shared array away from bulk-exporting every technician's signature image.
 *
 * Route annotations for those surfaces now use `ORG_REPORTING_ROLES` below.
 * `route-roles.spec.ts` pins the FULL `@Roles()` set of EVERY route, so the
 * next accidental widening through a shared constant fails CI instead of
 * waiting for a reviewer.
 * ############################################################################
 */
export const JOB_VIEW_ALL_ROLES = [
  'PLANNER',
  'TEAM_LEADER',
  'ENGINEER',
  'DOC_CONTROLLER',
  'ADMIN',
  'AUDITOR',
];

/**
 * The `@Roles()` list for the ORGANISATION-WIDE BULK surfaces — the
 * `/reports/*` family (PRD §9) and `POST /records/export` +
 * `GET /exports/{id}` + its download (PR-119/UR-059).
 *
 * Deliberately a SEPARATE constant from `JOB_VIEW_ALL_ROLES`, and
 * deliberately its exact PRE-slice-18 membership. These are not "can I see
 * this row" decisions: they are whole-organisation aggregates and a ZIP of
 * rendered PDFs carrying decrypted signatory names and signature images. The
 * set of people who may plan maintenance is not automatically the set of
 * people who may bulk-extract the plant's signed records, and collapsing the
 * two into one array is precisely the mistake slice 18's review caught.
 *
 * Adding a role here must be a deliberate, separately-reasoned act. It is
 * also mechanically visible: `route-roles.spec.ts` asserts the exact role set
 * of every route in the system, in both directions.
 */
export const ORG_REPORTING_ROLES = [
  'TEAM_LEADER',
  'ENGINEER',
  'DOC_CONTROLLER',
  'ADMIN',
  'AUDITOR',
];
export const JOB_RECORD_ROLES = ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'];

/**
 * Slice 32-PLANNERJOB — the roles that may DECIDE who does maintenance:
 * `POST /jobs/{jobId}/assign`, `PUT /schedule/{scheduleRuleId}/default-assignee`
 * and the picker that feeds them.
 *
 * NOT a route-annotation list — each of those routes writes its own `@Roles()`
 * literally, and `route-roles.spec.ts` pins them independently, so a future
 * narrowing of one cannot silently narrow the others (the same discipline the
 * banner on `JOB_VIEW_ALL_ROLES` above exists to enforce).
 *
 * It is used for ONE decision: whether `GET /schedule` includes decrypted
 * technician NAMES. See `planner-schedule.service.ts#list`.
 */
export const JOB_ASSIGNMENT_ROLES = ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'];

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
