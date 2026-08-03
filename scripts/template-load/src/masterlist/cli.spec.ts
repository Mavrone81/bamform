// scripts/template-load/src/masterlist/cli.spec.ts
/**
 * Slice masterlist-migration — Task 6 review fix round 1, IMPORTANT-3.
 *
 * Pins the dry-run-default safety property: nothing in CI previously caught
 * `apply` defaulting to `true`, or some other flag spelling silently also
 * flipping it. `main()` itself is exercised by actually running the CLI
 * (see the task report), not here — it is entrypoint glue guarded by
 * `require.main === module` specifically so `parseArgs` can be imported
 * without that side effect.
 */
import { computePastDueSummary, formatPastDueWarning, parseArgs } from './cli';
import type { MachineImportResult } from './import';

describe('parseArgs', () => {
  it('defaults apply to false with no flags', () => {
    expect(parseArgs([]).apply).toBe(false);
  });

  it('defaults year to 2026 and file to the committed fixture', () => {
    const args = parseArgs([]);
    expect(args.year).toBe(2026);
    expect(args.file).toMatch(/__fixtures__[/\\]masterlist\.xlsx$/);
  });

  it('"--apply" is the ONLY spelling that flips apply to true', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
    // Every other recognised flag leaves it false — no flag other than the
    // literal "--apply" may ever perform a write.
    expect(parseArgs(['--year=2026']).apply).toBe(false);
    expect(parseArgs(['--file=/tmp/x.xlsx']).apply).toBe(false);
    expect(parseArgs(['--year=2026', '--file=/tmp/x.xlsx']).apply).toBe(false);
  });

  it('parses --year=YYYY and --file=<path>', () => {
    const args = parseArgs(['--year=2030', '--file=/tmp/other.xlsx']);
    expect(args.year).toBe(2030);
    expect(args.file).toBe('/tmp/other.xlsx');
  });

  describe('argument rejection (process.exit(2) mocked so the test process survives it)', () => {
    let exitSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('rejects a malformed --year', () => {
      parseArgs(['--year=26']);
      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('rejects an unrecognised argument rather than silently ignoring it', () => {
      parseArgs(['--bogus']);
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--bogus'));
    });

    it('a near-miss spelling of --apply ("--Apply") is rejected as unknown, not treated as --apply', () => {
      const args = parseArgs(['--Apply']);
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(args.apply).toBe(false);
    });
  });
});

/**
 * Owner decision 2026-08-03 (decision 2): the plan is imported with its
 * true, mostly-historical dates — no rolling forward — but the operator
 * must see, at run time, how many of the rules about to be written are
 * already past due. `NOW` is fixed so these tests never depend on the
 * actual wall clock.
 */
describe('computePastDueSummary', () => {
  const NOW = new Date(2026, 7, 3); // 3 Aug 2026 (local), month is 0-indexed

  const base: Omit<MachineImportResult, 'label' | 'code' | 'assetTypeCode' | 'status'> = {
    blocked: false,
    documentAttached: true,
    leftUnplanned: false,
    dueDates: {},
    dueWeeks: {},
    machineNumber: null,
    surplus: [],
  };

  function machine(
    overrides: Partial<MachineImportResult> & { code: string },
  ): MachineImportResult {
    return {
      ...base,
      label: overrides.code,
      assetTypeCode: 'ASSET_A',
      status: 'imported',
      ...overrides,
    };
  }

  it('is all-zero for an empty machine list', () => {
    expect(computePastDueSummary([], NOW)).toEqual({
      totalRules: 0,
      pastDueRules: 0,
      pastDueMachines: 0,
      today: '2026-08-03',
    });
  });

  it('counts a rule with nextDueOn strictly before today as past due', () => {
    const m = machine({ code: 'M1', dueDates: { M1: '2026-01-29' } });
    expect(computePastDueSummary([m], NOW)).toEqual({
      totalRules: 1,
      pastDueRules: 1,
      pastDueMachines: 1,
      today: '2026-08-03',
    });
  });

  it('does NOT count nextDueOn == today or in the future', () => {
    const m = machine({
      code: 'M2',
      dueDates: { M1: '2026-08-03', M3: '2026-12-25' },
    });
    expect(computePastDueSummary([m], NOW)).toEqual({
      totalRules: 2,
      pastDueRules: 0,
      pastDueMachines: 0,
      today: '2026-08-03',
    });
  });

  it('counts a machine once even if several of its rules are past due', () => {
    const m = machine({
      code: 'M3',
      dueDates: { M1: '2026-01-01', M3: '2026-02-01', M6: '2026-12-01' },
    });
    const s = computePastDueSummary([m], NOW);
    expect(s.totalRules).toBe(3);
    expect(s.pastDueRules).toBe(2);
    expect(s.pastDueMachines).toBe(1);
  });

  it('excludes a left-unplanned (surplus) machine — it has no rules to be past due (decision 1)', () => {
    const m = machine({
      code: 'SURPLUS-01',
      leftUnplanned: true,
      dueDates: {},
      surplus: ['Y'],
    });
    expect(computePastDueSummary([m], NOW)).toEqual({
      totalRules: 0,
      pastDueRules: 0,
      pastDueMachines: 0,
      today: '2026-08-03',
    });
  });

  it('excludes skipped and blocked rows', () => {
    const skipped = machine({ code: 'SK01', status: 'skipped', dueDates: {} });
    const blocked = machine({
      code: 'BL01',
      status: 'unmapped',
      blocked: true,
      dueDates: {},
    });
    expect(computePastDueSummary([skipped, blocked], NOW)).toEqual({
      totalRules: 0,
      pastDueRules: 0,
      pastDueMachines: 0,
      today: '2026-08-03',
    });
  });

  it('adds up correctly across several machines', () => {
    const machines = [
      machine({ code: 'A', dueDates: { M1: '2026-01-01' } }), // past due
      machine({ code: 'B', dueDates: { M1: '2026-12-01' } }), // future
      machine({ code: 'C', leftUnplanned: true, dueDates: {}, surplus: ['Y'] }),
    ];
    expect(computePastDueSummary(machines, NOW)).toEqual({
      totalRules: 2,
      pastDueRules: 1,
      pastDueMachines: 1,
      today: '2026-08-03',
    });
  });
});

describe('formatPastDueWarning', () => {
  it("states the counts, today's date, and what the scheduler will actually do", () => {
    const msg = formatPastDueWarning({
      totalRules: 222,
      pastDueRules: 181,
      pastDueMachines: 73,
      today: '2026-08-03',
    });
    expect(msg).toBe(
      'PAST-DUE: 181 of 222 schedule rule(s) about to be written already have a nextDueOn ' +
        'before today (2026-08-03), across 73 machine(s). The scheduler will raise a job for ' +
        'each of these on its next sweep — for maintenance the plant may already have ' +
        'performed on paper.',
    );
  });

  it('still reports zero plainly, without implying a problem', () => {
    const msg = formatPastDueWarning({
      totalRules: 5,
      pastDueRules: 0,
      pastDueMachines: 0,
      today: '2026-08-03',
    });
    expect(msg).toContain('0 of 5 schedule rule(s)');
  });
});
