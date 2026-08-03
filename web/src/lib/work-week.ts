/**
 * WORK WEEKS — the plant's planning unit (slice 31-PLANNER).
 *
 * `ML-S-MFT-00015`, the spreadsheet this replaces, is 76 machines down the
 * side and 52 work weeks across. A planner says "that one is week 12"; the
 * system stores `2026-03-19`. BOTH have to be on screen: the week is how the
 * plan is thought about and talked about, the date is what is actually
 * written to `schedule_rule.next_due_on` and what a job will be raised
 * against.
 *
 * THE RULE, as the plant states it: work week 1 starts 1 January, and each
 * week is the next 7 days from there. It is deliberately NOT ISO 8601 week
 * numbering — ISO weeks start on a Monday and can put 1 January in week 52 or
 * 53 of the PREVIOUS year, which would put the first column of the 2026 grid
 * in 2025 and make the artefact this replaces disagree with its replacement
 * on the very first cell.
 *
 * THE 53rd WEEK. 365 days is 52 weeks and 1 day (366 in a leap year, 2 days),
 * so counting strictly in sevens produces a 53rd stub week of one or two
 * days. The plant's sheet has 52 columns. Rather than invent a column it does
 * not have — or drop 31 December off the plan, which is worse — week 52
 * ABSORBS the tail and runs 8 or 9 days. Every date in the year therefore
 * lands in exactly one of 52 columns, which is the property the grid needs
 * and the property the spreadsheet already has.
 *
 * Every function here is pure and works in UTC calendar days, matching the
 * `YYYY-MM-DD` dates the API emits. Nothing here consults the clock or the
 * host timezone — the same date must sit in the same column on a tablet in
 * the fab and on a desktop anywhere else.
 */

export const WORK_WEEKS_PER_YEAR = 52;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` -> UTC midnight, or `null` if it is not a usable date. */
export function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === iso ? date : null;
}

/** UTC date -> `YYYY-MM-DD`. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The work week (1..52) a date falls in, or `null` when the date is not in
 * `year` at all. Returning `null` rather than clamping is deliberate: a date
 * outside the grid's year has no cell, and silently folding it into week 1 or
 * 52 would draw a visit in a week it does not happen.
 */
export function workWeekOf(iso: string, year: number): number | null {
  const date = parseIsoDate(iso);
  if (!date || date.getUTCFullYear() !== year) return null;
  const dayIndex = Math.floor((date.getTime() - startOfYear(year).getTime()) / MS_PER_DAY);
  // The stub 53rd week folds into 52 — see the module note.
  return Math.min(Math.floor(dayIndex / 7) + 1, WORK_WEEKS_PER_YEAR);
}

/** The first day of a work week — 1 January for week 1, then every 7 days. */
export function workWeekStart(year: number, week: number): Date {
  const clamped = Math.min(Math.max(week, 1), WORK_WEEKS_PER_YEAR);
  return new Date(startOfYear(year).getTime() + (clamped - 1) * 7 * MS_PER_DAY);
}

/**
 * The last day of a work week. Week 52 ends on 31 December however long that
 * makes it (the absorbed tail), so the weeks of a year tile it exactly with
 * no gap and no overlap.
 */
export function workWeekEnd(year: number, week: number): Date {
  if (week >= WORK_WEEKS_PER_YEAR) {
    return new Date(Date.UTC(year, 11, 31));
  }
  return new Date(workWeekStart(year, week).getTime() + 6 * MS_PER_DAY);
}

/** `[1, 2, … 52]` — the grid's columns. */
export function workWeeksOfYear(): number[] {
  return Array.from({ length: WORK_WEEKS_PER_YEAR }, (_, index) => index + 1);
}

/** `WW01` … `WW52` — zero-padded so the column headers stay the same width. */
export function formatWorkWeek(week: number): string {
  return `WW${String(week).padStart(2, '0')}`;
}

/**
 * "WW12 · 19 Mar – 25 Mar" — the label that carries BOTH units at once.
 * Used wherever a week is named on its own (the column header's tooltip, the
 * selected-visit panel), so a planner never has to translate one into the
 * other in their head.
 */
export function describeWorkWeek(year: number, week: number): string {
  return `${formatWorkWeek(week)} · ${formatDayMonth(workWeekStart(year, week))} – ${formatDayMonth(
    workWeekEnd(year, week),
  )}`;
}

/** `19 Mar` — deliberately unambiguous about which number is the day. */
export function formatDayMonth(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** `19 Mar 2026`. */
export function formatFullDate(iso: string): string {
  const date = parseIsoDate(iso);
  return date ? `${formatDayMonth(date)} ${date.getUTCFullYear()}` : iso;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function startOfYear(year: number): Date {
  return new Date(Date.UTC(year, 0, 1));
}
