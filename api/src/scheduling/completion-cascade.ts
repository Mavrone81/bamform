import type { Frequency } from '@bamform/shared';

/**
 * PR-055/PR-056/ADR-009 — the "reverse direction" of the frequency cascade
 * (WORKFLOW_DIAGRAMS.md §3.1). When a job of frequency F is verified,
 * `last_completed_on` is updated for F **and every frequency subsumed by F**
 * (i.e. every entry in the job's own frozen `frequency_scope`, PR-053) —
 * completing the annual PM resets the 3M and 6M clocks too.
 *
 * `next_due_on` is computed from `last_completed_on` (ADR-009: anniversary
 * drift absorbed), never from the original anchor — a job completed a week
 * late does not immediately generate its successor (U-SCH-03).
 *
 * This is a pure function: no Prisma, no transaction, no clock. Slice 7's
 * verify transaction is the seam that calls it and persists the result
 * (`ScheduleRuleUpdateSink` below) — this slice implements and unit-tests
 * the computation only, per the brief ("wire the mechanism now ... the
 * actual call from the verify transaction lands in slice 7").
 */
export interface ScheduleRuleForCompletion {
  frequency: Frequency;
  intervalMonths: number;
}

export interface ScheduleRuleCompletionUpdate {
  frequency: Frequency;
  lastCompletedOn: Date;
  nextDueOn: Date;
}

/**
 * Adds `months` to `from`, clamping to the last day of the resulting month
 * when the source day doesn't exist there (U-SCH-04: 31 Jan + 1 month lands
 * on 28/29 Feb, never rolls over into March). Operates on UTC calendar
 * fields only — a `next_due_on` is a DATE, not a timestamp, so there is no
 * timezone to absorb (U-SIG-03-style host-timezone independence).
 */
export function addCalendarMonthsClamped(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  const targetMonthIndex = month + months;
  // Day 0 of the FOLLOWING month is the last day of the target month —
  // this is what clamps 31 Jan + 1 month to 28/29 Feb instead of 3 Mar.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(Date.UTC(year, targetMonthIndex, clampedDay));
}

/**
 * Given the completed job's frequency_scope (each with its interval), computes
 * the rolling next-due update every subsumed schedule_rule needs.
 */
export function computeCompletionCascade(
  verifiedOn: Date,
  scopedFrequencies: readonly ScheduleRuleForCompletion[],
): ScheduleRuleCompletionUpdate[] {
  return scopedFrequencies.map((rule) => ({
    frequency: rule.frequency,
    lastCompletedOn: verifiedOn,
    nextDueOn: addCalendarMonthsClamped(verifiedOn, rule.intervalMonths),
  }));
}
