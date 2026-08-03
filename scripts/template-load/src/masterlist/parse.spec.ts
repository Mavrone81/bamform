// scripts/template-load/src/masterlist/parse.spec.ts
import { join } from 'node:path';
import { parseMasterlist } from './parse';

const FIXTURE = join(__dirname, '__fixtures__', 'masterlist.xlsx');

describe('parseMasterlist', () => {
  const rows = parseMasterlist(FIXTURE);

  it('reads every machine row that carries a plan', () => {
    expect(rows).toHaveLength(77);
  });

  it('splits "Model -- CODE" into model and code', () => {
    const ed01 = rows.find((r) => r.code === 'ED01')!;
    expect(ed01.model).toBe('ESEC 2008 sc3 plus');
    expect(ed01.code).toBe('ED01');
  });

  it('treats a label with no separator as its own code', () => {
    const ep01 = rows.find((r) => r.code === 'EP01')!;
    expect(ep01.model).toBe('EP01');
  });

  it('takes the LAST token as the code for a multi-word label with no separator', () => {
    // This is the shape Task 1's original review missed: only ED01 (has a
    // separator) and EP01 (single token) were exercised, so reading the
    // whole label as the code for `ConnX-Elite Lite KW01` went undetected —
    // it would have registered the machine as `ConnX-Elite Lite KW01`
    // instead of the bare code `KW01`.
    const kw01 = rows.find((r) => r.label === 'ConnX-Elite Lite KW01')!;
    expect(kw01.code).toBe('KW01');
    expect(kw01.model).toBe('ConnX-Elite Lite');

    const dp01 = rows.find((r) => r.label === 'Pre Mixer DP01')!;
    expect(dp01.code).toBe('DP01');
    expect(dp01.model).toBe('Pre Mixer');
  });

  it('resolves every real KW and DP label to a bare code, not the whole label', () => {
    // Regression for the full family, not just one representative each —
    // the defect was silent for 18 of 77 rows, so a single example isn't
    // enough to trust this again.
    const kwRows = rows.filter((r) => /^ConnX-Elite Lite /.test(r.label));
    expect(kwRows).toHaveLength(13);
    for (const r of kwRows) {
      expect(r.code).toMatch(/^KW\d+$/);
      expect(r.code).not.toContain(' ');
    }

    const dpRows = rows.filter((r) => /^Pre Mixer /.test(r.label));
    expect(dpRows).toHaveLength(5);
    for (const r of dpRows) {
      expect(r.code).toMatch(/^DP\d+$/);
      expect(r.code).not.toContain(' ');
    }
  });

  it('still isolates DDA 03 by its full label even though the code is now just "03"', () => {
    const dda = rows.find((r) => r.label === 'DDA 03')!;
    expect(dda.code).toBe('03');
    expect(dda.label).toBe('DDA 03');
  });

  it('reads the planned visits in work-week order', () => {
    const ed01 = rows.find((r) => r.code === 'ED01')!;
    expect(ed01.visits).toEqual([
      { workWeek: 5, frequency: 'M6' },
      { workWeek: 18, frequency: 'M3' },
      { workWeek: 30, frequency: 'Y' },
      { workWeek: 43, frequency: 'M3' },
    ]);
  });

  it('reads a monthly machine as thirteen visits', () => {
    const ep01 = rows.find((r) => r.code === 'EP01')!;
    expect(ep01.visits).toHaveLength(13);
    expect(ep01.visits.every((v) => v.frequency === 'M1')).toBe(true);
  });

  it('excludes rows with no planned visit', () => {
    expect(rows.some((r) => r.visits.length === 0)).toBe(false);
    expect(rows.some((r) => /internal document/i.test(r.label))).toBe(false);
  });
});
