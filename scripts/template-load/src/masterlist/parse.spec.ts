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
