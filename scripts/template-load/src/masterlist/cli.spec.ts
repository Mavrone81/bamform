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
import { parseArgs } from './cli';

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
