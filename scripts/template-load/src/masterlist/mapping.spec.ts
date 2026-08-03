// scripts/template-load/src/masterlist/mapping.spec.ts
import { workWeekToDate, assetTypeCodeForModel, machineNumberFor, SKIPPED_LABELS } from './mapping';
import { resolveTemplateTitle } from '@bamform/shared';

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

describe('machineNumberFor', () => {
  // Shape 1: the code CONTAINS the token immediately before the blank (at
  // its start, for these three) -> supply what follows it. Confirmed by
  // KW08.pdf among the 204 signed records (fix round 1, owner decision
  // 2026-08-03).
  it('returns the remainder after the title-adjacent token, when the code contains it', () => {
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

  // Shape 2: the code does NOT contain that token anywhere -> supply the
  // WHOLE code. Confirmed by ST01-1M.pdf: the bare "Record______" fills
  // with "ST01", not "01" — its adjacent token is "Record", which "ST01"
  // does not contain.
  it('returns the whole code when it does not contain the title-adjacent token', () => {
    expect(machineNumberFor('MB E-Test Preventive Maintenance Record______', 'ST01')).toBe('ST01');
    // CM02/T8 are fed against the MB_ENCAPSULATION title here only to
    // exercise the function's fallback path with a token ("MB") the code
    // does not contain — NOT because CM02/T8 are ever actually rendered
    // against this title. In production both map to MB_E_TEST
    // ("MB E-Test ... Record______", asserted above via ST01), not
    // MB_ENCAPSULATION ("MB Encapsulation ... Record MB_____"); see
    // `assetTypeCodeForModel`'s `mb\s+cmt` rule above. Either title
    // produces the same result for these two codes, since neither "MB" nor
    // "Record" is a substring of "CM02" or "T8" — this is exactly the case
    // the old trailing-digit rule silently got wrong (it never looked at
    // the title at all).
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
    // Token adjacent to the blank is "35-" (hyphen is not whitespace or an
    // underscore). "AVS35-01" does not START WITH "35-", but it does
    // CONTAIN it (at index 3) — under the I3 review fix this is the
    // remainder-after-token shape, not the whole-code fallback. See the
    // `describe('machineNumberFor — I3 review fix ...')` block below for
    // the rendered-title check.
    expect(machineNumberFor(titleWithRealCrlf, 'AVS35-01')).toBe('01');
  });

  it('fills IMOS from the digit already printed in the title, per the I3 review fix', () => {
    // Token adjacent to "IMOS 0__"'s blank is "0" (one character); the real
    // code "IMOS-01" does not START WITH "0", but it does CONTAIN it (the
    // "0" in "-01") — under the I3 review fix this supplies what follows
    // that "0", i.e. "1", so the rendered title reads "...IMOS 0" + "1" =
    // "...IMOS 01", not the doubled "...IMOS 0IMOS-01" the old
    // starts-with-only rule produced. See the `describe('machineNumberFor
    // — I3 review fix ...')` block below for the rendered-title check.
    expect(machineNumberFor('OS Loading Preventive Maintenance Record IMOS 0__', 'IMOS-01')).toBe(
      '1',
    );
  });
});

/**
 * Whole-branch review finding I3: the "starts with" rule was too narrow —
 * `AVS35-01`/`AVS35-02`/`AVS35-03` and `IMOS-01` don't start with their
 * title's token, so the old rule fell back to the whole code and rendered a
 * duplicated machine number on every controlled PM record those four
 * machines produce. Widened to CONTAINS. These rows exercise both the raw
 * `machineNumberFor` output AND the full rendered title
 * (`resolveTemplateTitle`, `shared/src/template-title.ts`) against the
 * REAL committed YAML title strings — `scripts/template-load/yaml/
 * CE-95-055-00-01.yaml` and `CE-95-050-00-03.yaml` — not a hand-typed
 * approximation, so a future edit to either YAML's title breaks this test
 * instead of silently drifting.
 */
describe('machineNumberFor — I3 review fix: CONTAINS, not STARTS WITH', () => {
  // Real title strings as committed (CE-95-055-00-01.yaml stores an actual
  // CR/LF inside the double-quoted YAML scalar; reproduced literally here
  // rather than re-derived, same discipline as the CRLF test above).
  const AVS_TITLE = 'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-____';
  const IMOS_TITLE = 'OS Loading Preventive Maintenance Record IMOS 0__';

  it.each([
    ['AVS35-01', AVS_TITLE, '01', 'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-01'],
    ['AVS35-02', AVS_TITLE, '02', 'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-02'],
    ['AVS35-03', AVS_TITLE, '03', 'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-03'],
    ['IMOS-01', IMOS_TITLE, '1', 'OS Loading Preventive Maintenance Record IMOS 01'],
  ])(
    '%s fills %s -> machineNumber %j -> rendered title %j',
    (code, title, expectedMachineNumber, expectedRenderedTitle) => {
      const machineNumber = machineNumberFor(title, code);
      expect(machineNumber).toBe(expectedMachineNumber);
      expect(resolveTemplateTitle(title, machineNumber)).toBe(expectedRenderedTitle);
    },
  );
});
