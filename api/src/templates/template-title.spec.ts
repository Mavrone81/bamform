import { resolveTemplateTitle, titleHasFillableRun } from '@bamform/shared';

/**
 * Slice 27-ASSETDOC. The twelve real titles, verbatim from
 * `scripts/template-load/yaml/*.yaml` (byte-checked against those files, not
 * retyped from the spec — `IMOS 0__` really does carry exactly two
 * underscores, which is what pins the `{2,}` threshold).
 *
 * Lives in the api unit suite because `shared/` has no test runner of its own;
 * `completion-cascade.spec.ts` and `frequency-cascade.spec.ts` set the same
 * precedent of exercising shared exports from here.
 */
const WITH_RUN = [
  'BESI Die Attach Preventive Maintenance Record ED____',
  'KNS Wire Bond Preventive Maintenance Record KW___',
  'Besi Esec Wire Bond Preventive Maintenance Record EW_____',
  'MB Encapsulation Preventive Maintenance Record MB_____',
  'Pre-mixer machine Preventive Maintenance Record DP_____',
  'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-____',
  'OS Loading Preventive Maintenance Record IMOS 0__',
  'MB E-Test Preventive Maintenance Record______',
];
const WITHOUT_RUN = [
  // The number is already printed on the paper form — there is nothing to fill.
  'Preventive Maintenance Record EP01',
  'Preventive Maintenance Record PM01',
  // No machine designation at all.
  'ASM Wire Bond Preventive Maintenance Record',
  'Bump Dispensing Preventive Maintenance WI and Record',
];

describe('titleHasFillableRun', () => {
  it.each(WITH_RUN)('true for %s', (title) => expect(titleHasFillableRun(title)).toBe(true));
  it.each(WITHOUT_RUN)('false for %s', (title) => expect(titleHasFillableRun(title)).toBe(false));

  it('is true for exactly 8 of the 12 real templates', () => {
    // A flag that returned true for everything would satisfy the per-title
    // checks above only by accident of ordering; this pins the split itself,
    // and so pins the EP01/PM01 case the flag exists to serve.
    expect([...WITH_RUN, ...WITHOUT_RUN].filter(titleHasFillableRun)).toHaveLength(8);
  });

  it('a single underscore is not a blank — it is punctuation', () => {
    expect(titleHasFillableRun('Record for A_B')).toBe(false);
  });
});

describe('resolveTemplateTitle', () => {
  it('substitutes the number into the run', () => {
    expect(resolveTemplateTitle('KNS Wire Bond Preventive Maintenance Record KW___', '13')).toBe(
      'KNS Wire Bond Preventive Maintenance Record KW13',
    );
  });

  it('leaves the blank intact when no number is given — as the paper form is', () => {
    const title = 'BESI Die Attach Preventive Maintenance Record ED____';
    expect(resolveTemplateTitle(title, null)).toBe(title);
    expect(resolveTemplateTitle(title, undefined)).toBe(title);
    expect(resolveTemplateTitle(title, '')).toBe(title);
  });

  it('leaves a title with no run untouched, number or not', () => {
    // Owner, 2026-07-29: "Is ok some forms are already pre updated just allow
    // user to choose" — a machineNumber supplied here is accepted, and simply
    // has nothing to substitute into. Never an error.
    expect(resolveTemplateTitle('Preventive Maintenance Record EP01', '99')).toBe(
      'Preventive Maintenance Record EP01',
    );
  });

  it('substitutes only the FIRST run', () => {
    expect(resolveTemplateTitle('A ___ B ___', '7')).toBe('A 7 B ___');
  });

  it('treats a $-bearing machine number as literal text, not a replacement pattern', () => {
    // `String.prototype.replace` reads $&, $1 and friends in the REPLACEMENT
    // string. A machine number is admin-supplied free text, so a naive
    // implementation would mangle it (or splice the matched underscores back
    // in) — the substitution must be literal.
    expect(resolveTemplateTitle('Record KW___', 'A$&B')).toBe('Record KWA$&B');
    expect(resolveTemplateTitle('Record KW___', "$'")).toBe("Record KW$'");
  });
});
