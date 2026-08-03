// scripts/template-load/src/masterlist/mapping.ts

/**
 * Owner decision 2026-08-02: CALENDAR weeks, not ISO. Week n begins
 * `1 Jan + (n-1) x 7` days, so in 2026 every planned date is a Thursday.
 * Getting this wrong shifts all 77 machines by the same few days and every
 * later due date inherits the error, so the range is checked rather than
 * trusted.
 */
export function workWeekToDate(workWeek: number, year: number): string {
  if (!Number.isInteger(workWeek) || workWeek < 1 || workWeek > 53) {
    throw new Error(`work week out of range: ${workWeek}`);
  }
  const date = new Date(Date.UTC(year, 0, 1));
  date.setUTCDate(date.getUTCDate() + (workWeek - 1) * 7);
  return date.toISOString().slice(0, 10);
}

/**
 * Owner decision: the machine is not on site, so it is not imported at all.
 *
 * Matched against the row's LABEL, not its code. Since Task 1's parse fix the
 * code is the last token, so `DDA 03` yields the code `03` — checking the code
 * would silently stop skipping it and import a machine called `03`.
 */
export const SKIPPED_LABELS = ['DDA 03'] as const;

/**
 * ORDER MATTERS. `Besi ESEC 3xxx` (wire bond) must be tested before the
 * looser `ESEC 2008` (die attach) is reached, and both contain "ESEC".
 * Anything unmatched returns null and is reported, never guessed.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/besi\s+esec\s+3/i, 'BESI_ESEC_WIRE_BOND'],
  [/esec\s+2008/i, 'BESI_DIE_ATTACH'],
  [/asm\s+eagle/i, 'ASM_WIRE_BOND'],
  [/connx-elite/i, 'KNS_WIRE_BOND'],
  // Owner decision 2026-08-03 (fix round 2), settled by evidence: `MB CME`
  // and `MB CMT` machines carry DIFFERENT forms, not one. April's
  // `MB01.pdf` is titled "MB Encapsulation Preventive Maintenance Record MB
  // 01", CE 95 030 00 01 (MB_ENCAPSULATION) — but `CM01.pdf`/`T69.1.pdf` are
  // titled "MB E-Test Preventive Maintenance Record CM01"/"...T69", CE 95
  // 050 00 01 (MB_E_TEST), the SAME form as `MS-620 ST01` below. A single
  // `mb\s+(cme|cmt)` rule sent all twelve to Encapsulation — five machines
  // (CM01-03, T8, T69) would have gotten the wrong checklist on a
  // controlled record. Kept as two rules so `MB CME` cannot be shadowed.
  [/mb\s+cme/i, 'MB_ENCAPSULATION'],
  // Owner decision 2026-08-03 (fix round 1), settled by evidence, not
  // inference: of 204 real signed PM records supplied, February's
  // `ST01-1M.pdf` is titled "MB E-Test Preventive Maintenance Record ST01",
  // document CE 95 050 00 01 — the exact form MB_E_TEST was created from.
  // `MS-620 ST01`'s parsed model is `MS-620`. `MB CMT` (fix round 2) joins
  // it on the same asset type — see the comment above.
  [/mb\s+cmt|^ms-620/i, 'MB_E_TEST'],
  [/os\s+loading|imos/i, 'OS_LOADING'],
  [/pre\s?mixer|^dp\d/i, 'PRE_MIXER'],
  [/^bd\d/i, 'BUMP_DISPENSING'],
  [/^avs35/i, 'AVS_35'],
  [/^ep\d/i, 'EMERALD_PICK_PLACE'],
  [/^pm\d/i, 'POWATEC_MOUNTING'],
];

export function assetTypeCodeForModel(model: string, code: string): string | null {
  for (const [pattern, assetTypeCode] of RULES) {
    if (pattern.test(model) || pattern.test(code)) return assetTypeCode;
  }
  return null;
}

/**
 * The blank in a template title is a run of underscores (2+). What fills it
 * is derived from the TOKEN immediately before that run — the contiguous
 * non-whitespace, non-underscore text directly touching it (`Record
 * KW___` -> `KW`; `Record______` -> `Record`; `Record IMOS 0__` -> `0`).
 *
 * Owner decision 2026-08-03 (fix round 1), settled by two real specimens
 * from the 204 signed PM records supplied:
 *   - `KW08.pdf` fills `...Record KW___` with `08` — the code's REMAINDER
 *     after the token, because the code `KW08` starts with the token `KW`.
 *   - `ST01-1M.pdf` fills the bare `...Record______` with the WHOLE code
 *     `ST01`, not `01` — because the code `ST01` does NOT start with the
 *     token `Record`.
 *
 * So: if the code starts with the token (case-insensitively), supply the
 * remainder; otherwise supply the whole code. An earlier version of this
 * function always took the code's trailing digits, which happened to match
 * the KW/ED/DP/EW families (their token IS their code's alpha prefix) but
 * was never actually derived from the title, so it silently gave the wrong
 * answer for e.g. `MB Encapsulation ... Record MB_____` against a code like
 * `CM02` or `T8` (does not start with `MB` — whole code `CM02`/`T8`, not a
 * trailing digit) and for `ST01` against `Record______` (`01`, not `ST01`).
 *
 * `AVS 35-____` and `IMOS 0__` are NOT yet confirmed against a specimen —
 * this function is applied mechanically to them like every other template,
 * not special-cased; see the task report for what it currently produces.
 */
export function machineNumberFor(templateTitle: string, code: string): string | null {
  const blank = /([^\s_]*)_{2,}/.exec(templateTitle);
  if (!blank) return null;
  const token = blank[1];
  const trimmedCode = code.trim();
  const value = trimmedCode.toLowerCase().startsWith(token.toLowerCase())
    ? trimmedCode.slice(token.length)
    : trimmedCode;
  return value.length > 0 ? value : null;
}
