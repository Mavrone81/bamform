import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { ApplyDefaultAssigneeResult, AppliedJob, RefusedJob } from '@bamform/shared';
import type { ActorMeta } from '../common/actor-meta';
import { conflictProblem, validationFailedProblem } from '../common/domain-problems';
import { PlannerScheduleService } from '../scheduling/planner-schedule.service';
import { AssignmentService } from './assignment.service';
import { MAX_APPLY_DEFAULT_BATCH } from './rule-unassigned-jobs';

/**
 * Slice 33-APPLYDEFAULT — `POST /schedule/{scheduleRuleId}/default-assignee/
 * apply-to-existing`: hand the jobs a plan has ALREADY raised to the person
 * the plan now names.
 *
 * WHY THIS EXISTS. Setting a standing assignee deliberately does not cascade —
 * a planner editing next year's plan must not silently reassign work in
 * progress — and that is still true and still enforced. But on day one the
 * owner set "who normally does this" on four plans, logged in as the
 * technician and saw nothing: 4 rules carried a default, 0 jobs were assigned,
 * 195 were still unassigned. The behaviour was correct and the guidance was
 * useless, because the panel explained the rule only in terms of what it would
 * NOT do. So the planner is now told how many jobs are already sitting there
 * and offered this, as a second, deliberate act.
 *
 * WHAT MAKES IT SAFE RATHER THAN THE CASCADE IT REPLACED:
 *
 *  1. A SEPARATE REQUEST. Nothing here runs as a side effect of setting the
 *     default; `PUT .../default-assignee` still writes one column and no job.
 *     The planner has to see a count and press a second button.
 *  2. ONLY GENUINELY UNASSIGNED JOBS, and only ones still legally assignable —
 *     `rule-unassigned-jobs.ts`, the same predicate that produced the count.
 *     A job with somebody on it is never touched.
 *  3. THE ASSIGNEE IS RE-STATED AND RE-CHECKED. The planner answered a
 *     question about a NAMED person; if the plan changed underneath them
 *     between the offer and the answer, this refuses rather than assigning
 *     real work to somebody they never saw named.
 *  4. THE REAL PATH, PER JOB. Each assignment is `AssignmentService#assign` —
 *     the exact service `POST /jobs/{jobId}/assign` calls — so SCHEDULED
 *     becomes ASSIGNED through the state machine, each write is its own
 *     transaction with its own audit event, and each assignee gets the
 *     `JOB_ASSIGNED` notification. Nothing here bulk-UPDATEs `assigned_to`:
 *     a column write would produce assigned jobs with no audit trail and no
 *     notification, which is precisely the record the plant is regulated on.
 *
 * WHICH MODULE IT LIVES IN, and why it is not next to the endpoint it extends.
 * `AssignmentService` is in `JobsModule`, which imports `SchedulingModule`
 * (slice 15-SYSWIRE), so `SchedulingModule` cannot reach back for it. Rather
 * than reimplement the transition on the schedule side — the one thing the
 * brief forbids and the one thing that would quietly lose the audit trail —
 * the batch runs here and asks `PlannerScheduleService` for the schedule-shaped
 * half (resolve the rule, refuse an out-of-scope machine, select its jobs
 * through the area-scoped repository). Neither side restates the other's rule.
 *
 * PARTIAL FAILURE IS REPORTED, NEVER SWALLOWED OR ESCALATED. One refusal — a
 * job that changed state a moment ago, an assignee who has just lost their
 * area scope — must not abort the jobs after it and must not roll back the
 * ones before it, both of which are already committed and correctly assigned.
 * So every job is attempted and the response names each refusal with the
 * server's own `detail`.
 */
@Injectable()
export class RuleDefaultAssignmentService {
  private readonly logger = new Logger(RuleDefaultAssignmentService.name);

  constructor(
    private readonly planner: PlannerScheduleService,
    private readonly assignment: AssignmentService,
  ) {}

  async applyToExistingJobs(
    actor: ActorMeta,
    roles: string[],
    scheduleRuleId: string,
    dto: { assigneeId: string },
  ): Promise<ApplyDefaultAssigneeResult> {
    // 404 unknown rule / 403 out-of-scope machine, and the candidate jobs —
    // one round trip through the seam, area-scoped in the repository.
    const { rule, jobs } = await this.planner.findRuleWithUnassignedJobs(
      actor.actorId,
      scheduleRuleId,
      // One MORE than the cap, so "exactly the cap" and "more than the cap"
      // are distinguishable without a second count.
      MAX_APPLY_DEFAULT_BATCH + 1,
    );

    if (rule.defaultAssigneeId === null) {
      throw validationFailedProblem(
        'This plan has no standing assignee, so there is nothing to apply to the jobs it has ' +
          'already raised. Set who normally does this first.',
      );
    }
    if (rule.defaultAssigneeId !== dto.assigneeId) {
      // 409, not 422: nothing about the request is malformed — the world moved.
      throw conflictProblem(
        'The standing assignee for this plan changed after you were offered this, so nothing ' +
          'has been assigned. Reload the plan and decide again against the person it names now.',
      );
    }

    const attempt = jobs.slice(0, MAX_APPLY_DEFAULT_BATCH);
    const notAttempted = jobs.length - attempt.length;

    const assigned: AppliedJob[] = [];
    const refused: RefusedJob[] = [];

    /*
     * SEQUENTIAL, deliberately. Each iteration opens its own transaction and
     * appends to the hash-chained `audit_event` table; firing them at once
     * would contend on that chain for no benefit a planner could perceive on a
     * batch this size (a rule normally holds one live job).
     */
    for (const job of attempt) {
      try {
        await this.assignment.assign(
          job.id,
          { assigneeId: dto.assigneeId },
          // No `Idempotency-Key`. Assignment SETS a column to a named user
          // rather than appending anything, so a retried batch lands the same
          // jobs on the same person — the same reasoning `assignJob` in the
          // web client documents for the single-job call.
          undefined,
          actor,
          roles,
        );
        assigned.push({ jobId: job.id, jobNumber: job.jobNumber });
      } catch (error) {
        refused.push({
          jobId: job.id,
          jobNumber: job.jobNumber,
          reason: this.refusalReason(job.jobNumber, error),
        });
      }
    }

    return {
      scheduleRuleId,
      assigneeId: dto.assigneeId,
      assigned,
      refused,
      notAttempted,
    };
  }

  /**
   * The server's own words for why one job was refused.
   *
   * A DOMAIN REFUSAL is carried through verbatim: `AssignmentService` raises
   * RFC 9457 problems whose `detail` already says what a planner can act on
   * ("Job is SUBMITTED — ASSIGN is not a legal transition from this state"),
   * and paraphrasing it here would be a second copy of a message that is
   * already correct.
   *
   * ANYTHING ELSE is a fault, not a refusal, and must not be dressed as one:
   * it is logged with the job number and reported as what it is. Reporting it
   * as "refused" would tell a planner the job was ineligible, which is a claim
   * the server has not established.
   */
  private refusalReason(jobNumber: string, error: unknown): string {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { detail?: unknown }).detail === 'string'
      ) {
        return (body as { detail: string }).detail;
      }
      return error.message;
    }
    this.logger.error(
      `applying the standing assignee to job ${jobNumber} failed unexpectedly: ` +
        `${(error as Error)?.message ?? String(error)}`,
    );
    return (
      'This job could not be assigned because the server failed while applying it. Nothing ' +
      'was changed for this job; try it on its own from the plan.'
    );
  }
}
