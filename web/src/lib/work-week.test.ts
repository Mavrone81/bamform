import { describe, expect, it } from 'vitest';
import {
  WORK_WEEKS_PER_YEAR,
  describeWorkWeek,
  formatFullDate,
  formatWorkWeek,
  toIsoDate,
  workWeekEnd,
  workWeekOf,
  workWeekStart,
  workWeeksOfYear,
} from './work-week';

describe('workWeekOf — the plant’s own week numbering, not ISO 8601', () => {
  it('starts week 1 on 1 January, whatever weekday that is', () => {
    // 1 Jan 2026 is a Thursday. ISO 8601 would call it week 1 of 2026 too,
    // but 1 Jan 2027 is a Friday and ISO puts it in week 53 of 2026 — the
    // case below is what proves this is not ISO.
    expect(workWeekOf('2026-01-01', 2026)).toBe(1);
    expect(workWeekOf('2027-01-01', 2027)).toBe(1);
    expect(workWeekOf('2022-01-01', 2022)).toBe(1); // a Saturday; ISO says 2021-W52
  });

  it('runs each week for exactly seven days', () => {
    expect(workWeekOf('2026-01-07', 2026)).toBe(1);
    expect(workWeekOf('2026-01-08', 2026)).toBe(2);
    expect(workWeekOf('2026-01-14', 2026)).toBe(2);
    expect(workWeekOf('2026-01-15', 2026)).toBe(3);
  });

  it('puts mid-March in week 12', () => {
    // The brief's own example — "what is due in week 12".
    expect(workWeekOf('2026-03-19', 2026)).toBe(12);
    expect(workWeekOf('2026-03-25', 2026)).toBe(12);
    expect(workWeekOf('2026-03-26', 2026)).toBe(13);
  });

  /**
   * The stub-week decision, pinned. Counting strictly in sevens makes 31 Dec
   * a 53rd week of one day; the plant's sheet has 52 columns. Week 52 absorbs
   * the tail so every date in the year has exactly one cell.
   */
  describe('the 53rd-week tail folds into week 52', () => {
    it('non-leap year: 30 and 31 December are both week 52', () => {
      expect(workWeekOf('2026-12-24', 2026)).toBe(52);
      expect(workWeekOf('2026-12-30', 2026)).toBe(52);
      expect(workWeekOf('2026-12-31', 2026)).toBe(52);
    });

    it('leap year: the two extra days are week 52 as well', () => {
      expect(workWeekOf('2024-12-29', 2024)).toBe(52);
      expect(workWeekOf('2024-12-30', 2024)).toBe(52);
      expect(workWeekOf('2024-12-31', 2024)).toBe(52);
    });

    it('never returns a week outside 1..52, for any day of any year', () => {
      for (const year of [2024, 2025, 2026, 2027]) {
        for (let day = 0; day < 366; day += 1) {
          const date = new Date(Date.UTC(year, 0, 1 + day));
          if (date.getUTCFullYear() !== year) break;
          const week = workWeekOf(toIsoDate(date), year);
          expect(week).not.toBeNull();
          expect(week!).toBeGreaterThanOrEqual(1);
          expect(week!).toBeLessThanOrEqual(WORK_WEEKS_PER_YEAR);
        }
      }
    });
  });

  it('returns null for a date outside the grid’s year rather than clamping it', () => {
    // A rule anchored last year still carries its true `nextDueOn`; drawing
    // it in week 1 or 52 would show a visit in a week it does not happen.
    expect(workWeekOf('2025-12-31', 2026)).toBeNull();
    expect(workWeekOf('2027-01-01', 2026)).toBeNull();
  });

  it('returns null for a value that is not a calendar date', () => {
    expect(workWeekOf('', 2026)).toBeNull();
    expect(workWeekOf('2026-02-31', 2026)).toBeNull();
    expect(workWeekOf('2026-1-1', 2026)).toBeNull();
  });

  it('is timezone-independent — the same date is the same column everywhere', () => {
    // A date parsed as UTC midnight cannot slip a day west of Greenwich.
    expect(workWeekOf('2026-01-01', 2026)).toBe(1);
    expect(workWeekOf('2026-12-31', 2026)).toBe(52);
  });
});

describe('week boundaries tile the year exactly', () => {
  it('week 1 starts on 1 January and ends on the 7th', () => {
    expect(toIsoDate(workWeekStart(2026, 1))).toBe('2026-01-01');
    expect(toIsoDate(workWeekEnd(2026, 1))).toBe('2026-01-07');
  });

  it('week 52 ends on 31 December, longer than seven days', () => {
    expect(toIsoDate(workWeekStart(2026, 52))).toBe('2026-12-24');
    expect(toIsoDate(workWeekEnd(2026, 52))).toBe('2026-12-31');
  });

  it('every week begins the day after the previous one ends', () => {
    for (let week = 1; week < WORK_WEEKS_PER_YEAR; week += 1) {
      const end = workWeekEnd(2026, week).getTime();
      const nextStart = workWeekStart(2026, week + 1).getTime();
      expect(nextStart - end).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('each week contains the dates that report it, and no others (round trip)', () => {
    for (const week of workWeeksOfYear()) {
      expect(workWeekOf(toIsoDate(workWeekStart(2026, week)), 2026)).toBe(week);
      expect(workWeekOf(toIsoDate(workWeekEnd(2026, week)), 2026)).toBe(week);
    }
  });

  it('offers exactly 52 columns', () => {
    expect(workWeeksOfYear()).toHaveLength(52);
    expect(workWeeksOfYear()[0]).toBe(1);
    expect(workWeeksOfYear()[51]).toBe(52);
  });
});

describe('labels carry BOTH units — the week and the date', () => {
  it('pads the week number so the columns stay the same width', () => {
    expect(formatWorkWeek(1)).toBe('WW01');
    expect(formatWorkWeek(12)).toBe('WW12');
    expect(formatWorkWeek(52)).toBe('WW52');
  });

  it('names a week by its number AND its dates', () => {
    expect(describeWorkWeek(2026, 12)).toBe('WW12 · 19 Mar – 25 Mar');
    expect(describeWorkWeek(2026, 1)).toBe('WW01 · 1 Jan – 7 Jan');
    expect(describeWorkWeek(2026, 52)).toBe('WW52 · 24 Dec – 31 Dec');
  });

  it('formats a stored date unambiguously', () => {
    expect(formatFullDate('2026-03-19')).toBe('19 Mar 2026');
    // A value it cannot parse is shown verbatim rather than replaced by a
    // guess — the stored string is the honest thing to display.
    expect(formatFullDate('not-a-date')).toBe('not-a-date');
  });
});
