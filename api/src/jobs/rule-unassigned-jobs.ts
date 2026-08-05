import { JobStatusT, type FrequencyT, type Prisma } from '@prisma/client';
import { ALL_JOB_STATUSES, isLegalTransition } from './job-state-machine';

/**
 * Slice 33-APPLYDEFAULT — WHICH JOBS A STANDING ASSIGNEE MAY STILL BE APPLIED
 * TO, as ONE predicate, used by the count and by the batch that acts on it.
 *
 * WHY IT IS A SHARED FUNCTION AND NOT TWO QUERIES. The planner is shown a
 * number ("4 unassigned jobs already exist for this plan") and then presses a
 * button that assigns them. If the number came from one `where` and the batch
 * from another, the two would drift and the screen would promise a count it
 * could not deliver — the single most damaging thing this feature could do,
 * since it exists precisely because a planner was once told nothing had
 * happened when something had.
 *
 * THE THREE EXCLUSIONS, each load-bearing:
 *
 *  - `assignedTo: null` — GENUINELY UNASSIGNED ONLY. A job that already has
 *    somebody is never touched. That is the whole reason
 *    `PUT /schedule/{id}/default-assignee` does not cascade in the first
 *    place: a planner editing next year's plan must not silently reassign
 *    work in progress, and this feature must not become a back door to it.
 *
 *  - `status: { in: ASSIGNABLE_JOB_STATUSES }` — DERIVED FROM THE STATE
 *    MACHINE, never restated. `POST /jobs/{jobId}/assign` answers 409
 *    `invalid-transition` from SUBMITTED/VERIFIED/ARCHIVED/VOIDED
 *    (`job-state-machine.ts`), so offering those in the count would mean
 *    offering refusals. Computing the set from `isLegalTransition` means a
 *    future change to the lifecycle moves this filter with it.
 *
 *  - `isAdhoc: false` — an ad-hoc job (UR-028) carries an EMPTY
 *    `frequency_scope` and satisfies no schedule period at all. It can share
 *    an `(asset_document_id, frequency)` with a rule by coincidence, but it is
 *    off-plan work, not this plan's work, and the standing assignee on a
 *    maintenance schedule says nothing about who should take a call-out.
 *
 * WHAT IDENTIFIES "THIS RULE'S JOBS". `job` has no `schedule_rule_id`;
 * generation copies `assetDocumentId` and `frequency` verbatim off the rule,
 * and `schedule_rule` is `@@unique([asset_document_id, frequency])`, so that
 * tuple names exactly one rule. It is the same join
 * `planner-schedule.repository.ts#findScheduledJobsForVisits` uses, minus
 * `dueOn`: THAT one answers "the job for this visit", this one answers "every
 * job this plan has ever raised and still owns".
 */

/**
 * Every `JobStatusT` from which `ASSIGN` is a legal transition — today
 * SCHEDULED, ASSIGNED and IN_PROGRESS. Computed, so it cannot disagree with
 * `job-state-machine.ts`.
 */
export const ASSIGNABLE_JOB_STATUSES: readonly JobStatusT[] = ALL_JOB_STATUSES.filter((status) =>
  isLegalTransition(status, 'ASSIGN'),
);

/** The tuple that names one rule's jobs — see the module note. */
export interface RuleJobKey {
  assetDocumentId: string;
  frequency: FrequencyT;
}

export function unassignedJobsForRuleWhere(rule: RuleJobKey): Prisma.JobWhereInput {
  return {
    assetDocumentId: rule.assetDocumentId,
    frequency: rule.frequency,
    isAdhoc: false,
    assignedTo: null,
    status: { in: [...ASSIGNABLE_JOB_STATUSES] },
  };
}

/**
 * The most jobs one confirmation may apply to. A rule normally holds ONE live
 * job (generation raises the next due date's job and the date only advances on
 * completion), so this is a ceiling on a pathological plan rather than a
 * routine limit — but the response reports what it did not attempt rather than
 * letting the planner read a partial application as a complete one.
 *
 * It is deliberately small enough that the request stays a request: each job
 * is a separate transaction with its own audit write and notification enqueue,
 * exactly as a single assign is, and a batch of thousands would be a job for
 * the worker, not an HTTP handler a planner is waiting on.
 */
export const MAX_APPLY_DEFAULT_BATCH = 100;

/**
 * The complement of `ASSIGNABLE_JOB_STATUSES` — the states in which a job is
 * out of the technician's hands. Exported so tests can assert the exclusion by
 * name instead of re-deriving the very filter they are checking.
 */
export const NEVER_ASSIGNABLE_JOB_STATUSES: readonly JobStatusT[] = ALL_JOB_STATUSES.filter(
  (status) => !ASSIGNABLE_JOB_STATUSES.includes(status),
);
