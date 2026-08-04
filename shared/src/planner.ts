import { z } from 'zod';
import { frequencySchema } from './frequency';
import { jobStatusSchema } from './job';

/**
 * Slice 32-PLANNERJOB — THE JOB THE SCHEDULER ALREADY RAISED for a visit.
 *
 * Deliberately a HANDLE, not a summary: id (to open it), number (to name it)
 * and status (to say what state it is in). Everything else about the job is a
 * `GET /jobs/{jobId}` away, and duplicating a job summary into the planner
 * grid would make the plan a second, staler view of the work list.
 */
export const plannerVisitJobSchema = z.object({
  id: z.string().uuid(),
  jobNumber: z.string(),
  status: jobStatusSchema,
  /**
   * Who is responsible for doing it, or `null` while nobody is — the owner's
   * ask ("select which technician is responsible for the job so it can appear
   * as a job for him"), and the thing a planner scanning the plan is actually
   * looking for. A scheduler-generated job is born unassigned and is invisible
   * to the MAINTAINER who should do it (`job-access.ts` restricts them to
   * `assigned_to = me`), so "due, and nobody has it" is the state that matters
   * most on this screen.
   */
  assignedTo: z.string().uuid().nullable(),
  /**
   * The assignee's name, decrypted at read time (`app_user.full_name` is
   * application-layer encrypted, DBD §6.2). Sent because an id names nobody:
   * the planner has to see a person. `null` exactly when `assignedTo` is.
   *
   * This is a NARROW, deliberate use of the decryption path `GET /users`
   * already uses — one name for a job that exists, not a bulk export of the
   * directory. It is the only personal field on this row.
   */
  assignedToName: z.string().nullable(),
});
export type PlannerVisitJob = z.infer<typeof plannerVisitJobSchema>;

/**
 * Slice 32-PLANNERJOB — WHO NORMALLY DOES THIS PM.
 *
 * `schedule_rule.default_assignee_id`: the technician `JobGenerationService`
 * hands each generated job to. The second of two levels, and deliberately not
 * the same thing as `PlannerVisitJob.assignedTo`:
 *
 *   THIS is the plan — "AW01's quarterly PM is Bob's". It affects jobs not yet
 *   generated and nothing else.
 *   `nextDueJob.assignedTo` is one occurrence — "Bob is on leave, Sam does
 *   this one". It affects that job and nothing else.
 *
 * Changing either never writes the other. That independence is structural
 * (two endpoints, two columns, no write-back either way) and the planner is
 * told so in as many words, because a control that silently rewrote the plan
 * when someone covered a single visit would corrupt the schedule quietly.
 */
export const plannerDefaultAssigneeSchema = z.object({
  id: z.string().uuid(),
  /** Decrypted at read time — `app_user.full_name` is encrypted (DBD §6.2). */
  fullName: z.string(),
  /**
   * Whether this person would STILL be accepted for this machine today:
   * active, holding a result-recording role, and area-scoped to reach it.
   *
   * Sent, rather than left for the sweep to discover, because eligibility
   * lapses silently and usually will — someone leaves, a role is revoked, an
   * area scope is narrowed. When this is `false` the next sweep generates an
   * UNASSIGNED job (it does not refuse — the job is the controlled record),
   * so a planner needs to see it BEFORE the work goes out with nobody on it.
   */
  eligible: z.boolean(),
});
export type PlannerDefaultAssignee = z.infer<typeof plannerDefaultAssigneeSchema>;

/**
 * `PUT /schedule/{scheduleRuleId}/default-assignee` request.
 *
 * `null` CLEARS the standing assignee, returning the rule to generating
 * unassigned jobs. Explicitly nullable rather than optional: "leave it alone"
 * and "there is nobody" are different intentions, and an optional field
 * cannot express the second.
 *
 * NO REASON FIELD, deliberately — unlike `scheduleAdjustRequestSchema`, which
 * demands ten characters. Moving a due date changes WHEN controlled work
 * happens and is a compliance fact; deciding who does it is ordinary
 * day-to-day rostering that will change every time someone takes leave. A
 * mandatory reason there would be typed through, not thought about, and would
 * devalue the one on the date. The change is still audited with before/after.
 */
export const setDefaultAssigneeRequestSchema = z.object({
  defaultAssigneeId: z.string().uuid().nullable(),
});
export type SetDefaultAssigneeRequest = z.infer<typeof setDefaultAssigneeRequestSchema>;

/** `PUT /schedule/{scheduleRuleId}/default-assignee` response. */
export const setDefaultAssigneeResultSchema = z.object({
  scheduleRuleId: z.string().uuid(),
  defaultAssignee: plannerDefaultAssigneeSchema.nullable(),
});
export type SetDefaultAssigneeResult = z.infer<typeof setDefaultAssigneeResultSchema>;

/**
 * `GET /schedule` — the CROSS-MACHINE schedule read (slice 31-PLANNER).
 *
 * WHY THIS EXISTS. The plant plans preventive maintenance on a spreadsheet
 * (`ML-S-MFT-00015`): 76 machines down the side, 52 work weeks across, a mark
 * in the cell where a visit falls. That layout is the plan — it is what makes
 * a year readable at a glance and what lets a planner spread load so no week
 * is overloaded. `GET /assets/{assetId}/schedule` answers "when is THIS
 * machine due"; nothing could answer "what is due in week 12", across
 * machines, which is the question the spreadsheet exists to answer. Until
 * that could be asked here, the spreadsheet could not be retired.
 *
 * This is the tenant-wide sibling of `ScheduleRule`, not a replacement for
 * it. It carries the same rule identity (`id`, `assetDocumentId`,
 * `frequency`) precisely so a row read here can be adjusted through the
 * EXISTING `PUT /assets/{assetId}/schedule` — the planner grid and the
 * per-machine editor write through one code path, never two.
 */
export const plannerScheduleRowSchema = z.object({
  /** The `schedule_rule` id — the same identity `GET /assets/{id}/schedule` returns. */
  id: z.string().uuid(),

  // ---- the machine (the grid's row header)
  assetId: z.string().uuid(),
  assetCode: z.string(),
  assetDescription: z.string().nullable(),
  areaId: z.string().uuid().nullable(),

  // ---- the document the rule hangs off (slice 27-ASSETDOC)
  assetDocumentId: z.string().uuid(),
  documentNumber: z.string(),
  /**
   * The document's title with its fillable run substituted, exactly as
   * `GET /assets/{id}/documents` resolves it — derived at read time, never
   * stored resolved, so a revision that changes the title stays correct.
   */
  documentTitle: z.string(),

  // ---- the rule itself
  frequency: frequencySchema,
  intervalMonths: z.number().int(),
  nextDueOn: z.string(),
  lastCompletedOn: z.string().nullable(),
  adjustedReason: z.string().nullable(),
  active: z.boolean(),

  /**
   * Every date in the requested window this rule falls due on, ascending —
   * `nextDueOn`, then `nextDueOn + n·intervalMonths` (calendar months,
   * clamped, `addCalendarMonthsClamped`) for as long as the result stays
   * inside the window.
   *
   * A PROJECTION, not a promise. It is what the plan says today; a
   * completion, a void or a manual adjustment moves `nextDueOn` and the
   * projection with it (ADR-009: next due is computed from
   * `last_completed_on`, so a job completed late shifts every later visit).
   * It exists because a grid of a year cannot be drawn from a single next-due
   * date, and computing it in each client would put scheduling arithmetic
   * that already exists on the server into the browser and the app.
   *
   * MAY BE EMPTY: a rule whose `nextDueOn` precedes the window and whose
   * interval steps clean over it (a yearly rule against a one-month window)
   * has no visit inside it. The row is still returned — the planner is
   * entitled to see that the machine has a rule at all — it simply marks no
   * cell.
   */
  plannedDates: z.array(z.string()),

  /**
   * What ONE visit of this rule actually carries: the union of every
   * frequency on the same document whose interval divides this rule's
   * (`frequency-cascade.ts`, PR-053/U-CAS-07). A yearly visit subsumes the
   * 6M, 3M and 1M items, so it is a materially bigger piece of work than a
   * monthly one.
   *
   * Sent because the grid's whole purpose is spreading LOAD, and a load
   * figure that counted every cell as one unit would tell a planner that a
   * week of four monthly checks is heavier than a week of three annuals. It
   * is computed from the rules that actually exist on the document, not from
   * the divisibility table alone (U-CAS-05: a 3M rule on a document with no
   * 1M rule scopes to {M3} — there is nothing to do monthly there).
   */
  cascadeFrequencies: z.array(frequencySchema),

  /**
   * Slice 32-PLANNERJOB — the job `JobGenerationService` raised for THIS
   * rule's stored `nextDueOn`, or `null` when the sweep has not raised it yet.
   *
   * SCOPED TO `nextDueOn` AND NOTHING ELSE, deliberately. Every other date in
   * `plannedDates` is a projection of this one; job generation only ever reads
   * `schedule_rule.next_due_on` and writes `job.due_on` from it, so a
   * projected visit has no job and cannot have one until it becomes the stored
   * date. That is the same limit the grid already applies to the adjust form —
   * the stored date is the only one anything acts on.
   *
   * HOW THE JOB IS IDENTIFIED. `job` carries a partial unique index on
   * `(asset_document_id, frequency_scope, due_on) WHERE status <> 'voided' AND
   * is_adhoc = false`, and `JobGenerationService#generateForRule` writes
   * `assetDocumentId`, `frequency` and `dueOn` verbatim from the rule. Since
   * `schedule_rule` is `@@unique([asset_document_id, frequency])`, the tuple
   * `(assetDocumentId, frequency, nextDueOn)` names at most one such rule and
   * therefore at most one non-voided, non-ad-hoc job — see
   * `planner-schedule.repository.ts#findScheduledJobsForVisits` for why that
   * is matched rather than `frequency_scope`, which a schedule row alone
   * cannot reproduce.
   *
   * A VOIDED OR AD-HOC JOB IS NEVER THIS. A voided job releases its schedule
   * period (SYS-19) so the scheduler can raise a replacement; an ad-hoc job
   * (UR-028) carries an EMPTY `frequency_scope` and satisfies no period at
   * all. Linking either would point a planner at work that does not advance
   * this rule.
   */
  nextDueJob: plannerVisitJobSchema.nullable(),

  /**
   * The earliest date on which a scheduler sweep will raise the job for
   * `nextDueOn` — `nextDueOn` minus this machine's effective lead time
   * (`asset_type.lead_time_days`, falling back to the deployment's
   * `DEFAULT_LEAD_TIME_DAYS`). `YYYY-MM-DD`.
   *
   * Sent because the client CANNOT know it: the lead time is per asset type
   * with a server-configured default, so a screen printing "within 30 days"
   * would be asserting a number it has no way to verify, on the one screen
   * whose job is telling a planner when work appears. Computed by
   * `jobGenerationOpensOn()` — the same function
   * `JobGenerationService#generateDueJobs` uses for its own candidate test, so
   * the two cannot drift.
   *
   * It is a BOUNDARY, not an appointment: the sweep runs on its own cron, so
   * the job appears on the first sweep on or after this date, not at midnight
   * on it. It also promises nothing about whether a job will be raised at
   * all — a document with no current revision, or no active items in scope, is
   * skipped (`generateForRule` returns `'skipped'`).
   */
  jobGenerationOpensOn: z.string(),

  /**
   * WHO NORMALLY DOES THIS PM — `schedule_rule.default_assignee_id`, or
   * `null` where nobody is named and every generated job therefore arrives
   * unassigned. See `plannerDefaultAssigneeSchema` for how this differs from
   * `nextDueJob.assignedTo`, which is one occurrence rather than the plan.
   */
  defaultAssignee: plannerDefaultAssigneeSchema.nullable(),
});
export type PlannerScheduleRow = z.infer<typeof plannerScheduleRowSchema>;

/**
 * `GET /schedule` query. `from`/`to` are inclusive `YYYY-MM-DD` bounds and
 * both default to the current CALENDAR year (1 January – 31 December) — work
 * week 1 starts 1 January, so the plant's planning year and the calendar year
 * are the same year, and the default window is exactly one spreadsheet.
 *
 * Deliberately mirrors `complianceReportQuerySchema`'s loose `z.string()` for
 * the dates rather than inventing a stricter date type here: the service
 * parses and rejects an unusable value with the same `validation-failed`
 * problem every other malformed input gets.
 */
export const plannerScheduleQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  areaId: z.string().uuid().optional(),
  assetTypeId: z.string().uuid().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});
export type PlannerScheduleQuery = z.infer<typeof plannerScheduleQuerySchema>;
