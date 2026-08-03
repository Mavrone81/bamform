// scripts/template-load/src/masterlist/import.spec.ts
import { plannedDueDates } from './import';

describe('plannedDueDates', () => {
  it('takes the FIRST planned week for each frequency', () => {
    const visits = [
      { workWeek: 5, frequency: 'M6' as const },
      { workWeek: 18, frequency: 'M3' as const },
      { workWeek: 30, frequency: 'Y' as const },
      { workWeek: 43, frequency: 'M3' as const },
    ];
    expect(plannedDueDates(visits, 2026)).toEqual({
      M6: '2026-01-29',
      M3: '2026-04-30',
      Y: '2026-07-23',
    });
  });

  it('uses the earliest of thirteen monthly visits', () => {
    const visits = [1, 5, 9].map((w) => ({ workWeek: w, frequency: 'M1' as const }));
    expect(plannedDueDates(visits, 2026)).toEqual({ M1: '2026-01-01' });
  });

  it('returns one entry per frequency, not per visit', () => {
    const visits = [
      { workWeek: 2, frequency: 'M3' as const },
      { workWeek: 15, frequency: 'M3' as const },
      { workWeek: 28, frequency: 'M3' as const },
      { workWeek: 41, frequency: 'M3' as const },
    ];
    expect(Object.keys(plannedDueDates(visits, 2026))).toEqual(['M3']);
  });

  it('is empty for an empty visit list', () => {
    expect(plannedDueDates([], 2026)).toEqual({});
  });
});
