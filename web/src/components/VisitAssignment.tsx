import { useEffect, useRef, useState } from 'react';
import {
  applyDefaultAssigneeToExistingJobs,
  assignJob,
  setScheduleDefaultAssignee,
  type ApplyDefaultAssigneeResult,
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
 * Slice 33-APPLYDEFAULT — the offer the planner is left holding after the plan
 * has been written.
 *
 * `count` is the SERVER's count of jobs already raised for this rule that are
 * genuinely unassigned and still legally assignable — never derived here. The
 * screen can see one job (`nextDueJob`); the rule may own several, and a
 * number this component guessed at would be a promise it could not keep.
 */
interface ApplyOffer {
  assigneeId: string;
  assigneeName: string;
  count: number;
}

/** "4 unassigned jobs" / "1 unassigned job" — said once, used everywhere. */
function unassignedJobsPhrase(count: number): string {
  return `${count} unassigned job${count === 1 ? '' : 's'}`;
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
   * ------------------------------------------- slice 33-APPLYDEFAULT state
   *
   * WHAT WENT WRONG THAT THIS FIXES. The owner set "who normally does this"
   * on four plans, logged in as the technician, and saw nothing. That was
   * correct behaviour — the standing assignee applies to jobs the scheduler
   * raises from then on, and deliberately does not touch jobs already raised,
   * so a planner editing next year's plan cannot silently reassign work in
   * progress. But the panel explained it ONLY in terms of what it would not
   * do, so a planner who did the sensible thing was left with no next step and
   * 195 jobs still invisible to the people meant to do them.
   *
   * So when the write lands and the server reports jobs already sitting there
   * unassigned, the save is HELD OPEN: `onSaved` (which closes this panel and
   * reloads the grid) is deferred until the planner has answered the offer.
   *
   * IT IS AN OFFER, NOT A SIDE EFFECT AND NOT A PRE-TICKED BOX. Two buttons,
   * neither pre-selected, and "leave them" is a complete, unpenalised answer.
   */
  const [offer, setOffer] = useState<ApplyOffer | null>(null);
  /**
   * The standing assignee as the server reported it on the write, shown while
   * the offer is open. Without it the section above would still name the
   * PREVIOUS person — the grid has not reloaded yet, because reloading is what
   * the deferred `onSaved` does — and the planner would be asked to hand work
   * to one name while reading another.
   */
  const [savedDefault, setSavedDefault] = useState<PlannerDefaultAssignee | null | undefined>(
    undefined,
  );
  /** The success sentence owed to `onSaved`, once the offer is answered. */
  const [pendingMessage, setPendingMessage] = useState<string>('');
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<ApplyDefaultAssigneeResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const offerRef = useRef<HTMLDivElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  /**
   * Focus is MOVED to the offer, and then to its outcome.
   *
   * An `aria-live` region alone would announce the sentence and leave a
   * keyboard user's focus back on a Save button that no longer exists, several
   * controls away from the two that now matter. Each region is labelled by its
   * own text, so the move announces WHAT it is as well as that it happened.
   *
   * Done in an effect rather than `setTimeout(…, 0)` — which is what `Planner`
   * uses when it opens the detail panel, because there the target mounts in a
   * later commit. Here the region renders in the same commit that sets the
   * state, so the ref is attached by the time the effect runs, and a timer
   * would be both unnecessary and untestable under a frozen clock.
   */
  useEffect(() => {
    if (offer && !outcome) offerRef.current?.focus();
  }, [offer, outcome]);
  useEffect(() => {
    if (outcome) outcomeRef.current?.focus();
  }, [outcome]);

  /** Answering the offer either way finishes the save that has been held. */
  async function finish(message: string) {
    setOffer(null);
    setOutcome(null);
    setApplyError(null);
    setSavedDefault(undefined);
    await onSaved(message);
  }

  async function applyToExisting(pending: ApplyOffer) {
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyDefaultAssigneeToExistingJobs(scheduleRuleId, pending.assigneeId);
      if (!result.ok) {
        // The plan itself is already saved — only the extra step failed, and
        // saying so is the difference between "try again" and "did my change
        // go in at all?".
        setApplyError(
          refusalText(result.status, result.problem, 'Assigning the jobs already raised'),
        );
        return;
      }
      const applied = result.value;
      // A CLEAN SWEEP NEEDS NO ACKNOWLEDGEMENT: report it in the same sentence
      // as the plan change and let the grid reload, where the planner can see
      // the jobs now carrying a name.
      if (applied.refused.length === 0 && applied.notAttempted === 0) {
        await finish(
          `${pending.assigneeName} now normally does ${label}, and the ` +
            `${unassignedJobsPhrase(applied.assigned.length)} already raised for it ` +
            `${applied.assigned.length === 1 ? 'is' : 'are'} now theirs.`,
        );
        return;
      }
      // ANYTHING ELSE STAYS ON SCREEN. A refusal names a specific job the
      // planner has to deal with, and reloading the grid over the top of it
      // would be the silent drop this whole feature exists to stop.
      setOutcome(applied);
    } finally {
      setApplying(false);
    }
  }

  /*
   * A PROJECTED VISIT SHOWS NEITHER. It has no job to assign, and the plan it
   * follows from is stated on the stored next-due cell — repeating the rule's
   * standing assignee on every projected cell of the line would invite a
   * planner to think they were setting it "for December", which the schedule
   * cannot express (it holds one date and one default per rule, not a list).
   */
  if (!isNextDue) return null;

  const jobReassignable = job !== null && REASSIGNABLE_STATUSES.includes(job.status);

  /**
   * What the plan says RIGHT NOW: the server's answer while a write of ours is
   * still being resolved, the caller's props otherwise. `undefined` (never
   * written) is distinct from `null` (written, and it cleared the assignee).
   */
  const shownDefault = savedDefault === undefined ? defaultAssignee : savedDefault;
  /** While an offer or its outcome is open, that IS the task. */
  const resolving = offer !== null;

  return (
    <div className="visit-assignment" data-testid="visit-assignment">
      {/* ------------------------------------------------ level 1: the plan */}
      <section aria-labelledby={`${scheduleRuleId}-default-heading`}>
        <h3 id={`${scheduleRuleId}-default-heading`} className="kv-label">
          Who normally does this
        </h3>

        {shownDefault ? (
          <div className="kv-row">
            <span className="kv-value" data-testid="default-assignee-name">
              {/* `fullName` is null when the server WITHHELD it — the caller
                  holds no role that may decide assignment — or when the row
                  could not be decrypted. The id names nobody but is true, and
                  is what an admin can look up. */}
              {shownDefault.fullName ?? shownDefault.id}
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
        {shownDefault?.eligibility === 'not-assignable' && (
          <p className="banner" data-tone="bad" role="alert" data-testid="default-assignee-lapsed">
            <span aria-hidden="true">⚠</span> {shownDefault.fullName ?? shownDefault.id} can no
            longer be assigned to this machine — the account is inactive, has lost its
            maintainer/team-leader/engineer role, or its area scope no longer reaches here. The next
            scheduler sweep will still raise this job, but it will arrive UNASSIGNED. Pick somebody
            else.
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
        {shownDefault?.eligibility === 'unknown' && (
          <p
            className="banner"
            data-tone="attention"
            role="status"
            data-testid="default-assignee-unknown"
          >
            <span aria-hidden="true">?</span> Could not check whether{' '}
            {shownDefault.fullName ?? shownDefault.id} can still be assigned to this machine — the
            lookup did not complete. This is not a finding about them and nothing has changed: their
            standing assignment is intact. If the next sweep cannot check either, it will raise the
            job unassigned as a precaution. Try again shortly, and tell an administrator if it
            persists.
          </p>
        )}

        {/*
         * ---------------------------------------- slice 33-APPLYDEFAULT: the
         * offer. Rendered ABOVE the edit control and instead of it, because it
         * is now the only thing on this section worth doing: the plan has just
         * been written and the planner has one question to answer about it.
         *
         * A-05: every state here is words. The count, the exclusions, each
         * refusal and its reason are sentences; the icons are `aria-hidden`
         * decoration and nothing is carried by colour.
         */}
        {offer && !outcome && (
          <div
            className="apply-default-offer"
            ref={offerRef}
            tabIndex={-1}
            role="group"
            aria-labelledby={`${scheduleRuleId}-apply-offer-heading`}
            data-testid="apply-default-offer"
          >
            <p
              className="banner"
              data-tone="attention"
              id={`${scheduleRuleId}-apply-offer-heading`}
            >
              <span aria-hidden="true">◇</span>
              <span>
                Saved — {offer.assigneeName} now normally does {label}.{' '}
                {unassignedJobsPhrase(offer.count)} already exist
                {offer.count === 1 ? 's' : ''} for this plan, and{' '}
                {offer.count === 1 ? 'it is' : 'they are'} not covered by that: the standing
                assignee only applies to jobs raised from now on. Also assign{' '}
                {offer.count === 1 ? 'it' : 'them'} to {offer.assigneeName}?
              </span>
            </p>

            {/* THE HONEST BOUNDARY OF THE OFFER. The number above is what will
                change; this says what is deliberately not in it, so nobody
                reads "all this plan's jobs" into a count that never meant
                that. */}
            <p className="field-hint" data-testid="apply-default-scope">
              <span aria-hidden="true">⊘</span> Only jobs nobody holds are counted. Any job on this
              plan that already has a technician, or that has passed out of their hands, is left
              exactly as it is — and nothing on any other plan is touched.
            </p>

            {applyError && (
              <p className="banner" data-tone="bad" role="alert" data-testid="apply-default-error">
                <span aria-hidden="true">⚠</span>
                <span>
                  {applyError} The plan itself is saved: {offer.assigneeName} still normally does{' '}
                  {label}.
                </span>
              </p>
            )}

            <div className="dialog-actions">
              {/* "Leave them" is first and is a real answer, not a dismissal:
                  the planner may well have meant the change to apply from now
                  on only, which is what the plan alone already does. */}
              <button type="button" disabled={applying} onClick={() => void finish(pendingMessage)}>
                Leave {offer.count === 1 ? 'it' : 'them'} unassigned
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={applying}
                onClick={() => void applyToExisting(offer)}
              >
                {applying
                  ? 'Assigning…'
                  : `Also assign ${offer.count === 1 ? 'this job' : `these ${offer.count} jobs`} to ${offer.assigneeName}`}
              </button>
            </div>
          </div>
        )}

        {/*
         * THE OUTCOME, when it was not a clean sweep. A batch that reported
         * "done" while quietly dropping a job would be a worse version of the
         * defect this feature fixes, so every refusal is named with the job
         * number and the server's own reason, and the planner has to
         * acknowledge it before the panel closes.
         */}
        {outcome && offer && (
          <div
            className="apply-default-outcome"
            ref={outcomeRef}
            tabIndex={-1}
            role="alert"
            data-testid="apply-default-outcome"
          >
            <p className="banner" data-tone="attention">
              <span aria-hidden="true">⚠</span>
              <span>
                {outcome.assigned.length} of {outcome.assigned.length + outcome.refused.length} job
                {outcome.assigned.length + outcome.refused.length === 1 ? '' : 's'} assigned to{' '}
                {offer.assigneeName}.{' '}
                {outcome.refused.length > 0 &&
                  `${outcome.refused.length} could not be, and ${outcome.refused.length === 1 ? 'is' : 'are'} still unassigned:`}
              </span>
            </p>

            {outcome.refused.length > 0 && (
              <ul className="field-hint" data-testid="apply-default-refused">
                {outcome.refused.map((refusal) => (
                  <li key={refusal.jobId}>
                    Job {refusal.jobNumber} — {refusal.reason}
                  </li>
                ))}
              </ul>
            )}

            {outcome.notAttempted > 0 && (
              <p className="field-hint" data-testid="apply-default-not-attempted">
                <span aria-hidden="true">◇</span> {outcome.notAttempted} further unassigned job
                {outcome.notAttempted === 1 ? '' : 's'} on this plan{' '}
                {outcome.notAttempted === 1 ? 'was' : 'were'} not attempted — one confirmation
                covers a limited number. Run it again to take the next batch.
              </p>
            )}

            <div className="dialog-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  void finish(
                    `${pendingMessage} ${outcome.assigned.length} of ` +
                      `${outcome.assigned.length + outcome.refused.length} jobs already raised ` +
                      `were assigned; ${outcome.refused.length} could not be and remain unassigned.`,
                  )
                }
              >
                Done
              </button>
            </div>
          </div>
        )}

        {canAssign &&
          !resolving &&
          (editing === 'default' ? (
            <AssigneePicker
              scheduleRuleId={scheduleRuleId}
              currentAssigneeId={shownDefault?.id ?? null}
              currentAssigneeName={shownDefault?.fullName ?? null}
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
                const saved = result.value;
                const message = assigneeId
                  ? `${saved.defaultAssignee?.fullName ?? 'The technician'} now normally does ${label}.`
                  : `${label} no longer has a standing assignee — its jobs will generate unassigned.`;

                /*
                 * SLICE 33-APPLYDEFAULT — THE THING THAT WAS MISSING.
                 *
                 * The plan is saved and, as designed, not one existing job
                 * moved. If jobs are already sitting there unassigned, the
                 * planner is told and asked, HERE, before the panel closes.
                 *
                 * Only when somebody was named: clearing the standing assignee
                 * has nothing to offer, and offering "assign these to nobody"
                 * is not a thing the API can even express.
                 */
                if (assigneeId && saved.unassignedJobsAlreadyRaised > 0) {
                  setSavedDefault(saved.defaultAssignee);
                  setPendingMessage(message);
                  setOffer({
                    assigneeId,
                    assigneeName: saved.defaultAssignee?.fullName ?? 'the technician you chose',
                    // THE SERVER'S NUMBER, not one derived from this screen —
                    // it is the count of jobs the confirmation will actually
                    // walk, computed from the same predicate.
                    count: saved.unassignedJobsAlreadyRaised,
                  });
                  return { ok: true as const };
                }

                await onSaved(message);
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
                aria-label={`${shownDefault ? 'Change' : 'Set'} who normally does ${label}`}
                onClick={() => setEditing('default')}
              >
                {shownDefault ? 'Change who normally does this' : 'Set who normally does this'}
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

          {/* `!resolving` — while the plan's offer is open there is exactly one
              question on this panel. Reassigning THIS job underneath it would
              make the offer's count wrong by one with nothing to say so. The
              state of the job stays visible above; only the control waits. */}
          {canAssign &&
            !resolving &&
            jobReassignable &&
            (editing === 'job' ? (
              <AssigneePicker
                scheduleRuleId={scheduleRuleId}
                currentAssigneeId={job.assignedTo}
                currentAssigneeName={job.assignedToName}
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
