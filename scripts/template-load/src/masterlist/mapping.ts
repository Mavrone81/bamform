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
  [/mb\s+(cme|cmt)/i, 'MB_ENCAPSULATION'],
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
 * The blank in a template title is a run of underscores. The prefix before it
 * is already printed, so what gets supplied is the machine code's trailing
 * digits — `KW13` fills `KW___` with `13`, never `KW13`.
 *
 * No whitespace guard here. An earlier version of this function rejected any
 * code containing a space, to make `MS-620 ST01` return null — but at the
 * time `parseMasterlist` was handing this function whole labels like
 * `ConnX-Elite Lite KW01`, so the guard silently nulled 18 real machine
 * numbers across the KNS and Pre-Mixer families. The root cause was the
 * parse rule (Task 1's `code` field now takes the last whitespace-delimited
 * token when a label has no `--` separator), not this function, so this
 * always receives a bare code like `KW01`. `MS-620 ST01` now arrives as
 * `ST01` and yields `01` — harmless, because that machine maps to no asset
 * type and is imported with no document, so `machineNumber` is never read
 * for it.
 */
export function machineNumberFor(templateTitle: string, code: string): string | null {
  if (!/_{2,}/.test(templateTitle)) return null;
  const tail = /(\d+)\s*$/.exec(code.trim());
  return tail ? tail[1] : null;
}
