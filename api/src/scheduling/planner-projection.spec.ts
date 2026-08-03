import {
  MAX_PROJECTED_VISITS_PER_RULE,
  parseIsoDateOnly,
  projectVisitDates,
  toIsoDateOnly,
} from './planner-projection';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const project = (nextDueOn: string, intervalMonths: number, from: string, to: string) =>
  projectVisitDates(utc(nextDueOn), intervalMonths, utc(from), utc(to)).map(toIsoDateOnly);

/** The plant's own planning window: work week 1 starts 1 January. */
const YEAR_FROM = '2026-01-01';
const YEAR_TO = '2026-12-31';

describe('projectVisitDates — a schedule_rule across a planning window', () => {
  it('returns nextDueOn itself when it falls inside the window', () => {
    expect(project('2026-03-17', 12, YEAR_FROM, YEAR_TO)).toEqual(['2026-03-17']);
  });

  it('fills a year with twelve visits for a monthly rule', () => {
    const dates = project('2026-01-15', 1, YEAR_FROM, YEAR_TO);
    expect(dates).toHaveLength(12);
    expect(dates[0]).toBe('2026-01-15');
    expect(dates[11]).toBe('2026-12-15');
  });

  it('fills a year with four visits for a quarterly rule', () => {
    expect(project('2026-02-01', 3, YEAR_FROM, YEAR_TO)).toEqual([
      '2026-02-01',
      '2026-05-01',
      '2026-08-01',
      '2026-11-01',
    ]);
  });

  /**
   * The case the grid exists for: a rule anchored LAST year still has to draw
   * this year's cells. Advancing it is not optional — a planner opening 2026
   * on a rule last touched in 2025 would otherwise see an empty row for a
   * machine that is due every month.
   */
  it('advances a rule whose nextDueOn precedes the window, without returning the earlier visits', () => {
    const dates = project('2025-11-20', 3, YEAR_FROM, YEAR_TO);
    expect(dates).toEqual(['2026-02-20', '2026-05-20', '2026-08-20', '2026-11-20']);
  });

  it('returns nothing when the interval steps clean over a short window', () => {
    // A yearly rule due in June, asked about March. Real, and the reason
    // `plannedDates` is documented as possibly empty rather than assumed non-empty.
    expect(project('2026-06-01', 12, '2026-03-01', '2026-03-31')).toEqual([]);
  });

  it('includes both boundary dates — the window is inclusive at each end', () => {
    expect(project('2026-01-01', 12, YEAR_FROM, YEAR_TO)).toEqual(['2026-01-01']);
    expect(project('2026-12-31', 12, YEAR_FROM, YEAR_TO)).toEqual(['2026-12-31']);
  });

  it('excludes a rule due after the window', () => {
    expect(project('2027-02-01', 1, YEAR_FROM, YEAR_TO)).toEqual([]);
  });

  /**
   * THE MONTH-END ANCHOR. `addCalendarMonthsClamped` clamps 31 Jan + 1 month
   * to 28 Feb (U-SCH-04). Stepping from the previous RESULT would then walk
   * 28 Mar, 28 Apr … and silently lose the month end forever. Every occurrence
   * is computed from the original anchor precisely so the plan keeps saying
   * "the last day of the month", which is what it meant.
   */
  it('keeps the month-end anchor instead of drifting off a clamped February', () => {
    const dates = project('2026-01-31', 1, YEAR_FROM, '2026-05-31');
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('clamps into a leap February and still recovers the 29th the next leap year', () => {
    expect(project('2024-02-29', 12, '2024-01-01', '2028-12-31')).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
  });

  it('is independent of the host timezone (dates are UTC calendar dates, not instants)', () => {
    // Constructed the way Prisma hands back a `@db.Date` column.
    const dates = projectVisitDates(new Date('2026-07-01'), 6, utc(YEAR_FROM), utc(YEAR_TO));
    expect(dates.map(toIsoDateOnly)).toEqual(['2026-07-01']);
  });

  describe('bounds — a caller cannot ask one row to expand without limit', () => {
    it('stops at MAX_PROJECTED_VISITS_PER_RULE', () => {
      const dates = projectVisitDates(utc('2026-01-01'), 1, utc('2026-01-01'), utc('2999-12-31'));
      expect(dates).toHaveLength(MAX_PROJECTED_VISITS_PER_RULE);
    });

    it('does not spin on a corrupt, non-advancing interval', () => {
      expect(project('2026-03-01', 0, YEAR_FROM, YEAR_TO)).toEqual(['2026-03-01']);
      expect(project('2026-03-01', -1, YEAR_FROM, YEAR_TO)).toEqual(['2026-03-01']);
    });

    it('returns nothing for an inverted window', () => {
      expect(project('2026-03-01', 1, YEAR_TO, YEAR_FROM)).toEqual([]);
    });
  });
});

describe('parseIsoDateOnly — the planning window bounds', () => {
  it('accepts a well-formed calendar date as UTC midnight', () => {
    expect(toIsoDateOnly(parseIsoDateOnly('2026-01-01')!)).toBe('2026-01-01');
  });

  it('returns null for an absent value, so the caller can default it', () => {
    expect(parseIsoDateOnly(undefined)).toBeNull();
    expect(parseIsoDateOnly('')).toBeNull();
  });

  /**
   * `new Date('2026')` is 1 January 2026 and `new Date('2026-02-31')` rolls
   * into March. Accepting either would silently draw a whole year's grid from
   * a window the planner never asked for — hence the shape check AND the
   * round-trip check.
   */
  it('refuses shapes JavaScript would otherwise accept and reinterpret', () => {
    expect(parseIsoDateOnly('2026')).toBeNull();
    expect(parseIsoDateOnly('2026-1-1')).toBeNull();
    expect(parseIsoDateOnly('01/01/2026')).toBeNull();
    expect(parseIsoDateOnly('next tuesday')).toBeNull();
    expect(parseIsoDateOnly('2026-01-01T09:00:00Z')).toBeNull();
  });

  it('refuses a well-shaped date that does not exist', () => {
    expect(parseIsoDateOnly('2026-02-31')).toBeNull();
    expect(parseIsoDateOnly('2026-13-01')).toBeNull();
    expect(parseIsoDateOnly('2025-02-29')).toBeNull();
    expect(toIsoDateOnly(parseIsoDateOnly('2024-02-29')!)).toBe('2024-02-29');
  });
});
