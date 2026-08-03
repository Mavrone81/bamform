// scripts/template-load/src/masterlist/mapping.spec.ts
import { workWeekToDate, assetTypeCodeForModel, SKIPPED_LABELS } from './mapping';

describe('workWeekToDate — calendar weeks, owner decision 2026-08-02', () => {
  it('puts week 1 on 1 January', () => {
    expect(workWeekToDate(1, 2026)).toBe('2026-01-01');
  });

  it('advances exactly seven days per week', () => {
    expect(workWeekToDate(5, 2026)).toBe('2026-01-29');
    expect(workWeekToDate(18, 2026)).toBe('2026-04-30');
    expect(workWeekToDate(30, 2026)).toBe('2026-07-23');
    expect(workWeekToDate(52, 2026)).toBe('2026-12-24');
  });

  it('rejects a week outside 1-53 rather than producing a wild date', () => {
    expect(() => workWeekToDate(0, 2026)).toThrow();
    expect(() => workWeekToDate(54, 2026)).toThrow();
  });
});

describe('assetTypeCodeForModel', () => {
  it.each([
    ['ESEC 2008 sc3 plus', 'ED01', 'BESI_DIE_ATTACH'],
    ['ESEC 2008 hsc3 plus', 'ED07', 'BESI_DIE_ATTACH'],
    ['ASM Eagle Xtreme GoCu', 'AW01', 'ASM_WIRE_BOND'],
    ['ConnX-Elite Lite KW01', 'KW01', 'KNS_WIRE_BOND'],
    ['Besi ESEC 3200', 'BW01', 'BESI_ESEC_WIRE_BOND'],
    ['MB CME 3010 + TI2270', 'MB01', 'MB_ENCAPSULATION'],
    ['EP01', 'EP01', 'EMERALD_PICK_PLACE'],
    ['PM01', 'PM01', 'POWATEC_MOUNTING'],
    ['BD01', 'BD01', 'BUMP_DISPENSING'],
    ['AVS35-01', 'AVS35-01', 'AVS_35'],
    // Owner decision 2026-08-03 (fix round 1) — settled by evidence, not
    // inference: ST01-1M.pdf among the 204 supplied signed records is
    // titled "MB E-Test Preventive Maintenance Record ST01", CE 95 050 00
    // 01, the exact form MB_E_TEST was created from.
    ['MS-620', 'ST01', 'MB_E_TEST'],
    // Owner decision 2026-08-03 (fix round 2) — settled by evidence: `MB
    // CME` and `MB CMT` carry DIFFERENT forms. April's MB01.pdf is "MB
    // Encapsulation ... Record MB 01" (CE 95 030 00 01); CM01.pdf/
    // T69.1.pdf are "MB E-Test ... Record CM01"/"...T69" (CE 95 050 00 01,
    // same form as MS-620 ST01 above). A single `mb (cme|cmt)` rule sent
    // all twelve to Encapsulation — these real model strings pin both
    // halves of the split so that regression can't come back silently.
    ['MB CME 3060 + TI2280', 'MB03', 'MB_ENCAPSULATION'],
    ['MB CMT 6530', 'CM02', 'MB_E_TEST'],
    ['MB CMT 6530', 'T8', 'MB_E_TEST'],
    ['MB CMT 6560', 'CM01', 'MB_E_TEST'],
  ])('maps %s / %s', (model, code, expected) => {
    expect(assetTypeCodeForModel(model, code)).toBe(expected);
  });

  it('does NOT confuse Besi Die Attach with Besi Esec Wire Bond', () => {
    // "ESEC 2008" is die attach; "Besi ESEC 3xxx" is wire bond. Both contain
    // "ESEC" — matching loosely puts twenty machines on the wrong form.
    expect(assetTypeCodeForModel('ESEC 2008 hsc3 plus', 'ED03')).toBe('BESI_DIE_ATTACH');
    expect(assetTypeCodeForModel('Besi ESEC 3100 plus', 'BW02')).toBe('BESI_ESEC_WIRE_BOND');
  });

  it('lists DDA 03 as skipped', () => {
    expect(SKIPPED_LABELS).toContain('DDA 03');
  });
});
