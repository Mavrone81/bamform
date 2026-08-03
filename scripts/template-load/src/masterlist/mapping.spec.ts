// scripts/template-load/src/masterlist/mapping.spec.ts
import { workWeekToDate, assetTypeCodeForModel, machineNumberFor, SKIPPED_LABELS } from './mapping';

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
  ])('maps %s / %s', (model, code, expected) => {
    expect(assetTypeCodeForModel(model, code)).toBe(expected);
  });

  it('does NOT confuse Besi Die Attach with Besi Esec Wire Bond', () => {
    // "ESEC 2008" is die attach; "Besi ESEC 3xxx" is wire bond. Both contain
    // "ESEC" — matching loosely puts twenty machines on the wrong form.
    expect(assetTypeCodeForModel('ESEC 2008 hsc3 plus', 'ED03')).toBe('BESI_DIE_ATTACH');
    expect(assetTypeCodeForModel('Besi ESEC 3100 plus', 'BW02')).toBe('BESI_ESEC_WIRE_BOND');
  });

  it('returns null for a model with no form rather than guessing', () => {
    expect(assetTypeCodeForModel('MS-620 ST01', 'MS-620 ST01')).toBeNull();
  });

  it('lists DDA 03 as skipped', () => {
    expect(SKIPPED_LABELS).toContain('DDA 03');
  });
});

describe('machineNumberFor', () => {
  it('returns the numeric tail for a title with a blank', () => {
    expect(machineNumberFor('KNS Wire Bond Preventive Maintenance Record KW___', 'KW13')).toBe(
      '13',
    );
    expect(machineNumberFor('BESI Die Attach Preventive Maintenance Record ED____', 'ED01')).toBe(
      '01',
    );
  });

  it('handles a hyphenated code', () => {
    expect(
      machineNumberFor('Preventive Maintenance Work Instruction / Record AVS 35-____', 'AVS35-01'),
    ).toBe('01');
  });

  it('returns null when the title has no blank to fill', () => {
    // Emerald's title is a fixed "EP01" — filling it would corrupt the title.
    expect(
      machineNumberFor('Emerald Pick and Place Preventive Maintenance Record EP01', 'EP01'),
    ).toBeNull();
  });

  it('returns null when the code has no numeric tail rather than guessing', () => {
    expect(machineNumberFor('KNS Wire Bond Preventive Maintenance Record KW___', 'KW')).toBeNull();
  });

  it('extracts a tail from ST01 rather than nulling on it — parseMasterlist never hands this function a multi-word label', () => {
    // Before Task 1's parse fix, parseMasterlist gave this function the
    // whole label `MS-620 ST01`, and a whitespace guard here rejected it to
    // keep this specific case null. That guard also nulled 18 real machine
    // numbers (KW/DP families) that arrived as whole labels for the same
    // reason. The guard is gone; the fix is upstream — parseMasterlist now
    // always yields the bare code (`ST01`, not `MS-620 ST01`). Called
    // directly with `ST01`, this function has no way to know the machine is
    // untyped, so it returns '01' like any other code with a numeric tail.
    // That's safe: `MS-620 ST01` maps to no asset type
    // (assetTypeCodeForModel returns null for it) and is imported without a
    // document, so no template title ever exists for machineNumberFor to be
    // called against it in the real pipeline.
    expect(machineNumberFor('MB E-Test Preventive Maintenance Record______', 'ST01')).toBe('01');
  });

  it('finds the underscore run even when the title carries a literal CRLF elsewhere', () => {
    // scripts/template-load/yaml/CE-95-055-00-01.yaml stores this title as a
    // double-quoted YAML scalar with a \r\n escape; a YAML parser turns that
    // into real CR/LF characters ahead of the blank. The blank itself is
    // still a contiguous underscore run, so the regex must not be thrown off
    // by unrelated line breaks in the string.
    const titleWithRealCrlf = 'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-____';
    expect(machineNumberFor(titleWithRealCrlf, 'AVS35-01')).toBe('01');
  });
});
