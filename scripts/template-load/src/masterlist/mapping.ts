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

/** Owner decision: the machine is not on site, so it is not imported at all. */
export const SKIPPED_CODES = ['DDA 03'] as const;

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
 * A legitimate machine code is a single token (`KW13`, `ED01`, `AVS35-01`).
 * `MS-620 ST01` — the masterlist's un-typed machine, imported without a
 * document — is a two-word model + station label, not a code, even though it
 * ends in digits. Extracting `01` from it would be a guess dressed up as a
 * regex match, so codes containing whitespace are treated as having no
 * numeric tail at all.
 */
export function machineNumberFor(templateTitle: string, code: string): string | null {
  if (!/_{2,}/.test(templateTitle)) return null;
  const trimmed = code.trim();
  if (/\s/.test(trimmed)) return null;
  const tail = /(\d+)$/.exec(trimmed);
  return tail ? tail[1] : null;
}
