import { useState } from 'react';
import {
  assignJob,
  setScheduleDefaultAssignee,
  type PlannerDefaultAssignee,
  type PlannerVisitJob,
} from '../api/admin-client';
import { AssigneePicker } from './AssigneePicker';
import { refusalText } from './ScheduleAdjustForm';

/**
 * Job states a job may still be (re)assigned in — `job-state-machine.ts`'s
 * `ASSIGN` edges, mirrored. SUBMITTED/VERIFIED/ARCHIVED/VOIDED are absent
 * deliberately: the server answers 409 `invalid-transition` for those, and a
 * control that produced a 409 a planner can do nothing about is worse than no
 * control. Presentation only (non-negotiable #6) — the server decides.
 */
const REASSIGNABLE_STATUSES = ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'];

export interface VisitAssignmentProps {
  scheduleRuleId: string;
  /** WHO NORMALLY DOES THIS PM — `schedule_rule.default_assignee_id`. */
  defaultAssignee: PlannerDefaultAssignee | null;
  /** The job for the stored next-due date, or `null` while none is raised. */
  job: PlannerVisitJob | null;
  /** Only the stored next-due visit has a job or a plan worth showing. */
  isNextDue: boolean;
  /** Presentation gate — `rolesCanAssignJob`. The server is the authority. */
  canAssign: boolean;
  /** Names the visit, for the forms' accessible names. */
  label: string;
  /** Called after any successful write so the caller can reload its data. */
  onSaved: (message: string) => void | Promise<void>;
}

/**
 * THE TWO LEVELS OF ASSIGNMENT, ON ONE PANEL — slice 32-PLANNERJOB.
 *
 * The owner: "when planner create a plan maintenance it should allow the
 * assigning or change assigning later." That is two different things, and
 * conflating them is the defect this component exists to prevent:
 *
 *   THE PLAN — who normally does this machine's PM
 *   (`schedule_rule.default_assignee_id`). Affects jobs NOT YET GENERATED.
 *   Changing it must not touch work already raised, possibly already started.
 *
 *   THIS OCCURRENCE — who is doing the job that exists now
 *   (`job.assigned_to`, via `POST /jobs/{jobId}/assign`). Affects that one
 *   job. Covering a single visit because someone is on leave must NOT quietly
 *   rewrite the plan.
 *
 * The independence is structural, not merely intended: two endpoints, two
 * columns, and neither write reads or touches the other's column. But
 * structure the planner cannot SEE is no protection at all — someone who
 * thinks "assign" means one thing will use whichever control is nearest. So
 * the two are rendered as two named sections, each stating what it affects
 * ABOVE its own control, and each saying explicitly what it does NOT do.
 *
 * A-05: every state here is words. "Nobody", "Unassigned" and the
 * no-longer-eligible warning are sentences with icons, never a colour.
 */
export function VisitAssignment({
  scheduleRuleId,
  defaultAssignee,
  job,
  isNextDue,
  canAssign,
  label,
  onSaved,
}: VisitAssignmentProps) {
  const [editing, setEditing] = useState<'default' | 'job' | null>(null);

  /*
   * A PROJECTED VISIT SHOWS NEITHER. It has no job to assign, and the plan it
   * follows from is stated on the stored next-due cell — repeating the rule's
   * standing assignee on every projected cell of the line would invite a
   * planner to think they were setting it "for December", which the schedule
   * cannot express (it holds one date and one default per rule, not a list).
   */
  if (!isNextDue) return null;

  const jobReassignable = job !== null && REASSIGNABLE_STATUSES.includes(job.status);

  return (
    <div className="visit-assignment" data-testid="visit-assignment">
      {/* ------------------------------------------------ level 1: the plan */}
      <section aria-labelledby={`${scheduleRuleId}-default-heading`}>
        <h3 id={`${scheduleRuleId}-default-heading`} className="kv-label">
          Who normally does this
        </h3>

        {defaultAssignee ? (
          <div className="kv-row">
            <span className="kv-value" data-testid="default-assignee-name">
              {defaultAssignee.fullName}
            </span>
          </div>
        ) : (
          <p className="field-hint" data-testid="default-assignee-none">
            <span aria-hidden="true">◇</span> Nobody. Every job generated from this schedule arrives
            unassigned — and an unassigned job is invisible to the technician who should do it, so
            somebody has to hand it over by hand each time.
          </p>
        )}

        {/*
         * THE WARNING THAT MATTERS MOST ON THIS SCREEN. Eligibility lapses
         * silently: a technician leaves, a role is revoked, an area scope is
         * narrowed. The next sweep will then generate an UNASSIGNED job — it
         * does not refuse, because the job is the controlled record — and
         * nobody would notice until the work was late. The server computes
         * this (`defaultAssignee.eligibility`) so the planner sees it BEFORE
         * the sweep proves it.
         */}
        {defaultAssignee?.eligibility === 'not-assignable' && (
          <p className="banner" data-tone="bad" role="alert" data-testid="default-assignee-lapsed">
            <span aria-hidden="true">⚠</span> {defaultAssignee.fullName} can no longer be assigned
            to this machine — the account is inactive, has lost its maintainer/team-leader/engineer
            role, or its area scope no longer reaches here. The next scheduler sweep will still
            raise this job, but it will arrive UNASSIGNED. Pick somebody else.
          </p>
        )}

        {/*
         * COULD NOT CHECK — review finding, and deliberately NOT the message
         * above. That one accuses a named person of having lost their role;
         * saying it when the server merely failed to look would send a planner
         * to "fix" a perfectly good assignment, and quite possibly to replace
         * someone who never did anything wrong. So this states what actually
         * happened and asks for nothing.
         */}
        {defaultAssignee?.eligibility === 'unknown' && (
          <p
            className="banner"
            data-tone="attention"
            role="status"
            data-testid="default-assignee-unknown"
          >
            <span aria-hidden="true">?</span> Could not check whether {defaultAssignee.fullName} can
            still be assigned to this machine — the lookup did not complete. This is not a finding
            about them and nothing has changed: their standing assignment is intact. If the next
            sweep cannot check either, it will raise the job unassigned as a precaution. Try again
            shortly, and tell an administrator if it persists.
          </p>
        )}

        {canAssign &&
          (editing === 'default' ? (
            <AssigneePicker
              scheduleRuleId={scheduleRuleId}
              currentAssigneeId={defaultAssignee?.id ?? null}
              // The plan CAN have nobody — that is the state every rule is in
              // today, and returning to it is a legitimate decision.
              allowClear
              label={`Set who normally does ${label}`}
              saveLabel="Save who normally does this"
              affects={
                <>
                  <span aria-hidden="true">↻</span> This is the PLAN. It decides who future
                  generated jobs go to. It does NOT change any job already raised — including the
                  one on this visit, if there is one — and it does not move the due date.
                </>
              }
              onCancel={() => setEditing(null)}
              onSave={async (assigneeId) => {
                const result = await setScheduleDefaultAssignee(scheduleRuleId, assigneeId);
                if (!result.ok) {
                  return {
                    ok: false as const,
                    message: refusalText(
                      result.status,
                      result.problem,
                      'Saving the standing assignee',
                    ),
                  };
                }
                setEditing(null);
                await onSaved(
                  assigneeId
                    ? `${result.value.defaultAssignee?.fullName ?? 'The technician'} now normally does ${label}.`
                    : `${label} no longer has a standing assignee — its jobs will generate unassigned.`,
                );
                return { ok: true as const };
              }}
            />
          ) : (
            <div className="dialog-actions">
              {/*
               * The verb matches the visible label in BOTH forms (WCAG 2.5.3,
               * label in name): a speech-input user says what they can see, so
               * "Set who normally does this" must not answer to "Change…".
               */}
              <button
                type="button"
                aria-label={`${defaultAssignee ? 'Change' : 'Set'} who normally does ${label}`}
                onClick={() => setEditing('default')}
              >
                {defaultAssignee ? 'Change who normally does this' : 'Set who normally does this'}
              </button>
            </div>
          ))}
      </section>

      {/* ------------------------------------------ level 2: this occurrence */}
      {job && (
        <section aria-labelledby={`${scheduleRuleId}-job-heading`}>
          <h3 id={`${scheduleRuleId}-job-heading`} className="kv-label">
            Who is doing this one
          </h3>

          {job.assignedTo ? (
            <div className="kv-row">
              <span className="kv-value" data-testid="job-assignee-name">
                {job.assignedToName ?? job.assignedTo}
              </span>
            </div>
          ) : (
            <p className="field-hint" data-testid="job-assignee-none">
              <span aria-hidden="true">⚠</span> Unassigned. Job {job.jobNumber} exists but nobody
              holds it — and a technician only sees jobs assigned to them, so as things stand nobody
              can see this work at all.
            </p>
          )}

          {canAssign &&
            jobReassignable &&
            (editing === 'job' ? (
              <AssigneePicker
                scheduleRuleId={scheduleRuleId}
                currentAssigneeId={job.assignedTo}
                // A job cannot be UN-assigned: `assignJobRequestSchema`
                // requires a uuid and there is no endpoint that clears it.
                // Offering "nobody" here would be a control that always fails.
                allowClear={false}
                label={`Assign job ${job.jobNumber}`}
                saveLabel={job.assignedTo ? 'Reassign this job' : 'Assign this job'}
                affects={
                  <>
                    <span aria-hidden="true">◈</span> This is THIS JOB ONLY — job {job.jobNumber},
                    due once. Use it to cover a visit when the usual person is away. It does NOT
                    change who normally does this maintenance, so the next job still goes to whoever
                    is named above.
                  </>
                }
                onCancel={() => setEditing(null)}
                onSave={async (assigneeId) => {
                  // `allowClear={false}` and the disabled Save make this
                  // unreachable; narrowing rather than asserting keeps it that
                  // way if the props ever change.
                  if (!assigneeId) {
                    return { ok: false as const, message: 'Choose a technician for this job.' };
                  }
                  const result = await assignJob(job.id, assigneeId);
                  if (!result.ok) {
                    return {
                      ok: false as const,
                      message: refusalText(result.status, result.problem, 'Assigning this job'),
                    };
                  }
                  setEditing(null);
                  await onSaved(`Job ${job.jobNumber} assigned.`);
                  return { ok: true as const };
                }}
              />
            ) : (
              <div className="dialog-actions">
                <button
                  type="button"
                  aria-label={`${job.assignedTo ? 'Reassign' : 'Assign'} job ${job.jobNumber}`}
                  onClick={() => setEditing('job')}
                >
                  {job.assignedTo ? 'Reassign this job' : 'Assign this job'}
                </button>
              </div>
            ))}

          {/*
           * Said rather than left as a missing button: a job past SUBMITTED is
           * with the approver, and a planner looking for the control needs to
           * know it is gone on purpose. The server answers 409
           * `invalid-transition` for exactly these states.
           */}
          {canAssign && !jobReassignable && (
            <p className="field-hint" data-testid="job-assignee-locked">
              <span aria-hidden="true">⊘</span> Job {job.jobNumber} is {job.status} — it has left
              the technician's hands, so it can no longer be reassigned.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
