import { useRouter } from '../router';
import { StatusBadge } from './StatusBadge';
import { formatFullDate } from '../lib/work-week';
import type { components } from '../api/generated/openapi-types';

type PlannerVisitJob = components['schemas']['PlannerVisitJob'];

export interface VisitJobLinkProps {
  /**
   * The job `GET /schedule` reports against the rule's STORED next-due date
   * (`PlannerScheduleRow.nextDueJob`), or `null` when the scheduler has not
   * raised one yet.
   */
  job: PlannerVisitJob | null;
  /**
   * True only for the visit that IS the rule's `nextDueOn`. Every other cell
   * on the line is a projection of it, and nothing has been written against a
   * projection — see the module note.
   */
  isNextDue: boolean;
  /** `PlannerScheduleRow.jobGenerationOpensOn` — `YYYY-MM-DD`, server-computed. */
  jobGenerationOpensOn: string;
  /** Today as `YYYY-MM-DD`, from the caller's own clock helper. */
  today: string;
  /** Names the visit, for the button's accessible name. */
  label: string;
}

/**
 * THE BRIDGE FROM THE PLAN TO THE WORK — slice 32-PLANNERJOB.
 *
 * The planner shows when preventive maintenance is due; `/jobs/{id}` is where
 * a technician fills the form. Until this existed the two screens did not
 * meet, so a planner looking at a due visit had no way to reach it and had to
 * hunt the job list by machine code and date.
 *
 * A COMPONENT RATHER THAN INLINE MARKUP, for the reason `ScheduleAdjustForm`
 * was extracted: `Planner` (every machine, a grid) and `MachineSchedule` (one
 * machine, a list) are two ways of LOOKING at the same `schedule_rule`, and
 * the sentence "there is no job for this visit yet" must not become two
 * sentences that drift. This owns all three states and the destination.
 *
 * THE TRAP THIS EXISTS TO CLOSE. The obvious way to make a due visit
 * actionable is a "Raise this job" button on `POST /jobs/adhoc`. It would be
 * wrong twice over: an ad-hoc job is created with an EMPTY `frequencyScope`
 * (`shared/src/job.ts`), which makes it structurally incapable of advancing
 * `schedule_rule.next_due_on`, so planned work would be recorded as an
 * off-plan call-out AND the schedule would stay overdue for ever. There is
 * deliberately no create control here at all: a planned visit's job is the
 * scheduler's to raise, and the only honest thing this screen can do is say
 * when that will be. The waiting state says so in as many words, because a
 * planner who is told only "no job yet" will go and raise one.
 *
 * A-05 THROUGHOUT: every state is an icon AND words. `StatusBadge` carries the
 * server's own status vocabulary verbatim; the waiting and projected states
 * are sentences, not a greyed-out button.
 */
export function VisitJobLink({
  job,
  isNextDue,
  jobGenerationOpensOn,
  today,
  label,
}: VisitJobLinkProps) {
  const { navigate } = useRouter();

  /*
   * A PROJECTED VISIT CANNOT HAVE A JOB, and this is the same limit the grid
   * already states about the adjust form rather than a second rule.
   * `JobGenerationService` reads `schedule_rule.next_due_on` and writes
   * `job.due_on` from it; the later cells on a line are this year's projection
   * of that one date (`plannedDates`), and nothing has ever been written
   * against them. Saying "no job yet" here would be true but misleading — it
   * implies waiting is all that stands between this cell and a job, when in
   * fact the rule has to reach the date first.
   */
  if (!isNextDue) {
    return (
      <p className="field-hint" data-testid="visit-job-projected">
        <span aria-hidden="true">◇</span> No job, and none possible yet: a job is raised against the
        stored next due date only. This visit gets one when the schedule reaches it.
      </p>
    );
  }

  if (job) {
    return (
      <div className="visit-job" data-testid="visit-job-open">
        <div className="card-row">
          <span className="kv-label">Job</span>
          <span className="job-code">{job.jobNumber}</span>
        </div>
        <div className="card-row">
          {/* Icon + the server's exact status word — never a coloured dot. */}
          <StatusBadge status={job.status} />
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn-primary"
            aria-label={`Open job ${job.jobNumber} for ${label}`}
            onClick={() => navigate(`/jobs/${job.id}`)}
          >
            Open job {job.jobNumber}
          </button>
        </div>
      </div>
    );
  }

  /*
   * NO JOB, AND THE BOUNDARY HAS ALREADY PASSED. `jobGenerationOpensOn` is
   * server-computed from this machine's own lead time, so if it is behind us a
   * sweep has already had its chance. That is not necessarily a fault —
   * `generateForRule` skips a document with no CURRENT template revision, or
   * with no active items in the rule's cascade scope — but it is not "wait and
   * it will appear" either, and saying so would leave a planner watching a
   * cell that never fills.
   */
  if (jobGenerationOpensOn <= today) {
    return (
      <p className="field-hint" data-testid="visit-job-overdue-generation">
        <span aria-hidden="true">⚠</span> No job has been raised for this visit, and the scheduler
        has been past the point of raising one since {formatFullDate(jobGenerationOpensOn)}. Either
        a sweep has not run since then, or this document has nothing to raise — no current revision,
        or no active items at this frequency. Do not raise it by hand as an ad-hoc job: off-plan
        work never advances the next due date, so this visit would look done while the schedule
        stayed exactly where it is.
      </p>
    );
  }

  return (
    <p className="field-hint" data-testid="visit-job-pending">
      <span aria-hidden="true">◇</span> No job yet. The scheduler raises this visit's job on its
      first sweep on or after {formatFullDate(jobGenerationOpensOn)} — that is this machine type's
      lead time before the due date, set on the server. There is nothing to open until then, and
      nothing to do: raising it by hand as an ad-hoc job would record planned work as an off-plan
      call-out and would not advance the next due date.
    </p>
  );
}
