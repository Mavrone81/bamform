import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import {
  intervalDivides,
  resolveCascadeItems,
  resolveCascadeFrequencyScope,
  type FrequencyCascadeItem,
} from './frequency-cascade';

/** Builds `count` items of each given frequency, in the shape U-CAS-08..10 describe. */
function items(counts: Partial<Record<Frequency, number>>): FrequencyCascadeItem[] {
  const out: FrequencyCascadeItem[] = [];
  for (const [freq, count] of Object.entries(counts) as [Frequency, number][]) {
    for (let i = 0; i < count; i += 1) {
      out.push({ frequency: freq, intervalMonths: FREQUENCY_INTERVAL_MONTHS[freq] });
    }
  }
  return out;
}

function countBy(resolved: FrequencyCascadeItem[]): Partial<Record<Frequency, number>> {
  const counts: Partial<Record<Frequency, number>> = {};
  for (const item of resolved) {
    counts[item.frequency] = (counts[item.frequency] ?? 0) + 1;
  }
  return counts;
}

describe('frequency cascade (PR-053, TEST_PLAN §5.1)', () => {
  // A representative template covering every frequency, used by U-CAS-01..04.
  const allFrequencyItems = items({ M1: 2, M3: 2, M6: 2, Y: 2 });

  it('U-CAS-01: 1M job -> items: 1M', () => {
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M1, allFrequencyItems);
    expect(countBy(resolved)).toEqual({ M1: 2 });
  });

  it('U-CAS-02: 3M job -> items: 1M + 3M', () => {
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M3, allFrequencyItems);
    expect(countBy(resolved)).toEqual({ M1: 2, M3: 2 });
  });

  it('U-CAS-03: 6M job -> items: 1M + 3M + 6M', () => {
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M6, allFrequencyItems);
    expect(countBy(resolved)).toEqual({ M1: 2, M3: 2, M6: 2 });
  });

  it('U-CAS-04: Y job -> items: 1M + 3M + 6M + Y', () => {
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.Y, allFrequencyItems);
    expect(countBy(resolved)).toEqual({ M1: 2, M3: 2, M6: 2, Y: 2 });
  });

  it('U-CAS-05: template with no 1M items, 3M job -> items: 3M only, no error', () => {
    const noM1 = items({ M3: 4, M6: 2 });
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M3, noM1);
    expect(countBy(resolved)).toEqual({ M3: 4 });
    expect(resolveCascadeFrequencyScope(FREQUENCY_INTERVAL_MONTHS.M3, noM1)).toEqual(['M3']);
  });

  it('U-CAS-06: cascade_override present -> override honoured, computed set ignored', () => {
    // CE 95 043 00 01's Remarks (OI-08) — if the client ever confirms this is a
    // genuine exception rather than a transcription error: 6M/Y maintenance
    // covers only 1M + 6M, explicitly excluding 3M despite 3 dividing 6.
    const template = items({ M1: 2, M3: 2, M6: 2, Y: 2 });
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M6, template, ['M1', 'M6']);
    expect(countBy(resolved)).toEqual({ M1: 2, M6: 2 });
    expect(
      resolveCascadeFrequencyScope(FREQUENCY_INTERVAL_MONTHS.M6, template, ['M1', 'M6']),
    ).toEqual(['M1', 'M6']);
  });

  it('U-CAS-07: a new frequency (2-yearly) introduced is included in Y-and-above by divisibility, no code change', () => {
    // Deliberately outside the closed `Frequency` union — proves the engine
    // (`intervalDivides`) has zero hardcoded knowledge of frequency labels;
    // adding a real biennial frequency would only require a new
    // FREQUENCY_INTERVAL_MONTHS entry (shared/src/frequency.ts), never a
    // change to this cascade logic.
    const biennialIntervalMonths = 24;
    const candidateIntervals = [1, 3, 6, 12, 24];

    for (const candidate of candidateIntervals) {
      expect(intervalDivides(biennialIntervalMonths, candidate)).toBe(true);
    }
    // A candidate that does NOT divide evenly is correctly excluded.
    expect(intervalDivides(biennialIntervalMonths, 5)).toBe(false);

    const biennialTemplate = [
      { frequency: 'M1' as Frequency, intervalMonths: 1 },
      { frequency: 'M3' as Frequency, intervalMonths: 3 },
      { frequency: 'M6' as Frequency, intervalMonths: 6 },
      { frequency: 'Y' as Frequency, intervalMonths: 12 },
      // Stand-in for a hypothetical new frequency — same shape, same function.
      { frequency: 'BIENNIAL' as unknown as Frequency, intervalMonths: 24 },
    ];
    const resolved = resolveCascadeItems(biennialIntervalMonths, biennialTemplate);
    expect(resolved).toHaveLength(5);
  });

  it('U-CAS-08: real data CE 95 020 00 01 (ASM Wire Bond) Y job -> all 14 items present (8×3M, 4×6M, 2×Y)', () => {
    const template = items({ M3: 8, M6: 4, Y: 2 });
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.Y, template);
    expect(resolved).toHaveLength(14);
    expect(countBy(resolved)).toEqual({ M3: 8, M6: 4, Y: 2 });
  });

  it('U-CAS-09: real data CE 95 010 00 01 (Besi Die Attach) 6M job -> 17 items, 14×3M + 3×6M; the Y item excluded', () => {
    const template = items({ M3: 14, M6: 3, Y: 1 });
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M6, template);
    expect(resolved).toHaveLength(17);
    expect(countBy(resolved)).toEqual({ M3: 14, M6: 3 });
  });

  it('U-CAS-10: real data CE 95 043 00 01 (Bump Dispensing) 6M job -> 16 items under the uniform rule, flagged pending OI-08', () => {
    const template = items({ M1: 10, M3: 5, M6: 1, Y: 2 });
    const resolved = resolveCascadeItems(FREQUENCY_INTERVAL_MONTHS.M6, template);
    expect(resolved).toHaveLength(16);
    expect(countBy(resolved)).toEqual({ M1: 10, M3: 5, M6: 1 });
  });
});
