// scripts/template-load/src/masterlist/reconcile.spec.ts
import { reconcile } from './reconcile';

// NOTE: the brief's literal test fixture used the key `EMERALD_PICK_AND_PLACE`,
// but mapping.ts's real rule for `^ep\d` (see mapping.spec.ts) yields
// `EMERALD_PICK_PLACE` — no `AND`. Using the brief's spelling verbatim makes
// assetTypeCodeForModel('EP01', 'EP01') miss this map entirely, so
// formDefines silently becomes [] and the "missing" test fails for the wrong
// reason (both M1 and M6 report missing, not just M6 as intended). Trusting
// the code (mapping.ts) over the brief's prose per task instructions.
const forms = {
  ASM_WIRE_BOND: ['M3', 'M6', 'Y'],
  EMERALD_PICK_PLACE: ['M1', 'M3'],
};

const row = (code: string, model: string, freqs: string[]) => ({
  label: model,
  model,
  code,
  visits: freqs.map((f, i) => ({ workWeek: i * 4 + 1, frequency: f as never })),
});

describe('reconcile', () => {
  it('reports no difference when plan and form agree', () => {
    const [r] = reconcile([row('AW01', 'ASM Eagle Xtreme GoCu', ['M3', 'M6', 'Y'])], forms);
    expect(r.surplus).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('reports a frequency the form defines but the plan does not schedule', () => {
    const [r] = reconcile([row('AW06', 'ASM Eagle Xtreme GoCu', ['M3', 'M6'])], forms);
    expect(r.surplus).toEqual(['Y']);
    expect(r.missing).toEqual([]);
  });

  it('reports a frequency the plan needs but the form cannot describe', () => {
    const [r] = reconcile([row('EP01', 'EP01', ['M1', 'M6'])], forms);
    expect(r.missing).toEqual(['M6']);
  });

  it('leaves assetTypeCode null for an unmapped model', () => {
    // MS-620 ST01 (this test's example before fix round 1) is no longer
    // unmapped — owner decision 2026-08-03, settled by evidence (a signed
    // PM record titled "MB E-Test Preventive Maintenance Record ST01"):
    // mapping.ts now maps it to MB_E_TEST. Using a synthetic example here
    // instead so this test keeps testing the null path.
    const [r] = reconcile([row('ZZ99', 'Some Unmapped Machine', ['M1'])], forms);
    expect(r.assetTypeCode).toBeNull();
  });

  it('deduplicates a repeated frequency — EP01 is thirteen monthly visits, one rule', () => {
    const [r] = reconcile([row('EP01', 'EP01', ['M1', 'M1', 'M1'])], forms);
    expect(r.planned).toEqual(['M1']);
  });
});
