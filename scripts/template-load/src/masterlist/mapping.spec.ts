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
    // Owner decision 2026-08-03 (fix round 1) — settled by evidence, not
    // inference: ST01-1M.pdf among the 204 supplied signed records is
    // titled "MB E-Test Preventive Maintenance Record ST01", CE 95 050 00
    // 01, the exact form MB_E_TEST was created from.
    ['MS-620', 'ST01', 'MB_E_TEST'],
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

describe('machineNumberFor', () => {
  // Shape 1: the code STARTS WITH the token immediately before the blank ->
  // supply the remainder. Confirmed by KW08.pdf among the 204 signed records
  // (fix round 1, owner decision 2026-08-03).
  it('returns the remainder after the title-adjacent token, when the code starts with it', () => {
    expect(machineNumberFor('KNS Wire Bond Preventive Maintenance Record KW___', 'KW13')).toBe(
      '13',
    );
    expect(machineNumberFor('BESI Die Attach Preventive Maintenance Record ED____', 'ED01')).toBe(
      '01',
    );
    expect(machineNumberFor('MB Encapsulation Preventive Maintenance Record MB_____', 'MB03')).toBe(
      '03',
    );
  });

  // Shape 2: the code does NOT start with that token -> supply the WHOLE
  // code. Confirmed by ST01-1M.pdf: the bare "Record______" fills with
  // "ST01", not "01" — its adjacent token is "Record", which "ST01" does
  // not start with.
  it('returns the whole code when it does not start with the title-adjacent token', () => {
    expect(machineNumberFor('MB E-Test Preventive Maintenance Record______', 'ST01')).toBe('ST01');
    // Same template family (MB_____), same token "MB" — but CM02/T8 do not
    // start with "MB", so unlike MB03 above they get the whole code, not a
    // trailing-digit remainder. This is exactly the case the old
    // trailing-digit rule silently got wrong (it never looked at the title).
    expect(machineNumberFor('MB Encapsulation Preventive Maintenance Record MB_____', 'CM02')).toBe(
      'CM02',
    );
    expect(machineNumberFor('MB Encapsulation Preventive Maintenance Record MB_____', 'T8')).toBe(
      'T8',
    );
  });

  it('returns null when the title has no blank to fill', () => {
    // Emerald's title is a fixed "EP01" — filling it would corrupt the title.
    expect(
      machineNumberFor('Emerald Pick and Place Preventive Maintenance Record EP01', 'EP01'),
    ).toBeNull();
  });

  it('returns null when the code exactly equals the token, leaving nothing to fill', () => {
    expect(machineNumberFor('KNS Wire Bond Preventive Maintenance Record KW___', 'KW')).toBeNull();
  });

  it('finds the underscore run even when the title carries a literal CRLF elsewhere', () => {
    // scripts/template-load/yaml/CE-95-055-00-01.yaml stores this title as a
    // double-quoted YAML scalar with a \r\n escape; a YAML parser turns that
    // into real CR/LF characters ahead of the blank. The blank itself is
    // still a contiguous underscore run, so the regex must not be thrown off
    // by unrelated line breaks in the string.
    const titleWithRealCrlf = 'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-____';
    // NOT YET CONFIRMED against a specimen (unlike KW08/ST01 above). The
    // token adjacent to the blank is "35-" (hyphen is not whitespace or an
    // underscore); "AVS35-01" does not start with "35-", so this is the
    // whole-code shape. Applied mechanically, not special-cased — see the
    // task report.
    expect(machineNumberFor(titleWithRealCrlf, 'AVS35-01')).toBe('AVS35-01');
  });

  it('is NOT YET CONFIRMED for IMOS — applied mechanically like every other template', () => {
    // Token adjacent to "IMOS 0__"'s blank is "0" (one character); the real
    // code "IMOS-01" does not start with "0", so this is also the
    // whole-code shape. See the task report.
    expect(machineNumberFor('OS Loading Preventive Maintenance Record IMOS 0__', 'IMOS-01')).toBe(
      'IMOS-01',
    );
  });
});
