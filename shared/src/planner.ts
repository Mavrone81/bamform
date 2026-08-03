import { z } from 'zod';
import { frequencySchema } from './frequency';

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
