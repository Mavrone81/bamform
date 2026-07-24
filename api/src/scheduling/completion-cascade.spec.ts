import { FREQUENCY_INTERVAL_MONTHS } from '@bamform/shared';
import { addCalendarMonthsClamped, computeCompletionCascade } from './completion-cascade';

describe('completion cascade (PR-055/PR-056, ADR-009, TEST_PLAN §5.2)', () => {
  it('U-SCH-01: Y job verified -> last_completed_on updated for 1M, 3M, 6M and Y', () => {
    const verifiedOn = new Date('2026-07-24T00:00:00Z');
    const scope = [
      { frequency: 'M1' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.M1 },
      { frequency: 'M3' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.M3 },
      { frequency: 'M6' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.M6 },
      { frequency: 'Y' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.Y },
    ];

    const updates = computeCompletionCascade(verifiedOn, scope);

    expect(updates.map((u) => u.frequency)).toEqual(['M1', 'M3', 'M6', 'Y']);
    for (const update of updates) {
      expect(update.lastCompletedOn).toEqual(verifiedOn);
    }
  });

  it('U-SCH-02: 3M job verified -> 1M and 3M updated; 6M and Y untouched (frequency_scope for a 3M job is only {1M,3M})', () => {
    const verifiedOn = new Date('2026-07-24T00:00:00Z');
    // frequency_scope for a 3M job (PR-053) never includes 6M/Y — the
    // completion cascade only ever receives what's frozen into it, so "6M
    // and Y untouched" falls out of computeCompletionCascade being called
    // with just this scope, not a special case in the function itself.
    const scope = [
      { frequency: 'M1' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.M1 },
      { frequency: 'M3' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.M3 },
    ];

    const updates = computeCompletionCascade(verifiedOn, scope);

    expect(updates.map((u) => u.frequency)).toEqual(['M1', 'M3']);
  });

  it('U-SCH-03: job completed 7 days late -> next due = completion + interval, not anchor + interval', () => {
    const anchor = new Date('2026-07-01T00:00:00Z');
    const actualVerification = new Date('2026-07-08T00:00:00Z'); // 7 days after the 1M anchor
    const scope = [{ frequency: 'M1' as const, intervalMonths: FREQUENCY_INTERVAL_MONTHS.M1 }];

    const updates = computeCompletionCascade(actualVerification, scope);

    const expectedFromCompletion = new Date('2026-08-08T00:00:00Z');
    const wouldBeFromAnchor = new Date('2026-08-01T00:00:00Z');
    expect(updates[0].nextDueOn).toEqual(expectedFromCompletion);
    expect(updates[0].nextDueOn).not.toEqual(wouldBeFromAnchor);
    expect(anchor.getTime()).toBeLessThan(actualVerification.getTime()); // sanity: genuinely late
  });

  it('U-SCH-04: leap year, 31 Jan anchor, monthly -> 28/29 Feb handled, no invalid date (rolls into March)', () => {
    // 2028 is a leap year (29 Feb exists); 2026 is not (28 Feb).
    expect(addCalendarMonthsClamped(new Date('2028-01-31T00:00:00Z'), 1)).toEqual(
      new Date('2028-02-29T00:00:00Z'),
    );
    expect(addCalendarMonthsClamped(new Date('2026-01-31T00:00:00Z'), 1)).toEqual(
      new Date('2026-02-28T00:00:00Z'),
    );
    // Never silently overflows into March.
    const rolled = addCalendarMonthsClamped(new Date('2026-01-31T00:00:00Z'), 1);
    expect(rolled.getUTCMonth()).toBe(1); // February (0-indexed)
  });
});
