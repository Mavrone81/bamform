import { addCalendarMonthsClamped } from './completion-cascade';

/**
 * Slice 31-PLANNER — projecting a `schedule_rule` forward across a planning
 * window, for `GET /schedule`.
 *
 * A rule stores ONE `next_due_on`. A year grid needs every date that rule
 * falls due on inside the window, or a 52-week planner drawn from 230 rules
 * would show 230 marks in a year that really contains far more visits.
 *
 * This is a pure function: no Prisma, no clock, no timezone. Every date is a
 * UTC calendar date, matching `next_due_on`'s `@db.Date` (there is no
 * timestamp to absorb — see `addCalendarMonthsClamped`'s own note).
 *
 * IT DOES NOT WRITE ANYTHING AND PROMISES NOTHING. `JobGenerationService`
 * raises exactly one job per due date and advances nothing; it is verification
 * (`completion-cascade.ts`) or a manual adjustment that moves `next_due_on`,
 * and ADR-009 recomputes from `last_completed_on`, so a job completed late
 * shifts every later visit. The projection therefore describes the plan AS IT
 * STANDS, which is exactly what a planner is looking at when they decide
 * whether week 12 is overloaded — not a prediction of what will happen.
 */

/**
 * A hard ceiling on how many visits one rule may contribute to one response.
 * A monthly rule over the default one-year window yields 12; the largest
 * sensible window a planner asks for is a few years. This exists so a
 * caller-supplied `to` far in the future (or a corrupt `interval_months`)
 * cannot turn one row into an unbounded array — it bounds the loop, it is not
 * a business rule.
 */
export const MAX_PROJECTED_VISITS_PER_RULE = 256;

/**
 * Every date in `[from, to]` (both inclusive) on which `nextDueOn` falls due,
 * ascending.
 *
 * Each occurrence is computed as `nextDueOn + n·intervalMonths` from the
 * ORIGINAL `nextDueOn`, never by repeatedly adding one interval to the
 * previous result. That distinction is load-bearing: `addCalendarMonthsClamped`
 * clamps 31 January + 1 month to 28 February, and stepping from the clamped
 * result would then walk 28 March, 28 April … permanently losing the month-end
 * anchor. Multiplying from the anchor keeps 31 Jan -> 28 Feb -> 31 Mar, which
 * is what the scheduler itself does (it always recomputes from a stored
 * anchor, never from a previously derived date).
 *
 * `nextDueOn` EARLIER THAN `from` is normal and is not skipped over: the rule
 * is simply advanced until it reaches the window. An occurrence before `from`
 * is not returned — a past-due date outside the window is not this window's
 * business, and the row still carries its true `nextDueOn` for a caller that
 * wants to say so.
 */
export function projectVisitDates(
  nextDueOn: Date,
  intervalMonths: number,
  from: Date,
  to: Date,
): Date[] {
  // A non-positive interval would never advance — the loop below would spin
  // until the ceiling on a row that cannot recur. `schedule_rule.interval_months`
  // is always >= 1 in practice (PR-053 derives it from the frequency), so this
  // is a guard against corrupt data, not an expected branch.
  if (!Number.isFinite(intervalMonths) || intervalMonths < 1) {
    return isWithin(nextDueOn, from, to) ? [nextDueOn] : [];
  }
  if (to.getTime() < from.getTime()) {
    return [];
  }

  const dates: Date[] = [];
  for (let step = 0; step < MAX_PROJECTED_VISITS_PER_RULE; step += 1) {
    const occurrence =
      step === 0 ? nextDueOn : addCalendarMonthsClamped(nextDueOn, step * intervalMonths);
    if (occurrence.getTime() > to.getTime()) {
      break;
    }
    if (occurrence.getTime() >= from.getTime()) {
      dates.push(occurrence);
    }
  }
  return dates;
}

function isWithin(date: Date, from: Date, to: Date): boolean {
  return date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

/**
 * Parses a `YYYY-MM-DD` query value into a UTC calendar date, or `null` when
 * it is absent or not a usable date. The caller decides what to do with
 * `null` (default it, or refuse) — this never throws, so one helper serves
 * both the "omitted, use the default" and the "supplied but nonsense" cases.
 *
 * Deliberately strict about the SHAPE: `new Date('2026')` parses to 1 January
 * 2026 and `new Date('next tuesday')` is `Invalid Date`, and neither should
 * be silently accepted as a planning window bound a whole year's grid is
 * drawn from.
 */
export function parseIsoDateOnly(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Rejects a well-shaped but non-existent date (`2026-02-31`), which
  // JavaScript would otherwise roll forward into March without complaint.
  if (parsed.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return parsed;
}

/** `YYYY-MM-DD`, matching every other date this API emits. */
export function toIsoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
