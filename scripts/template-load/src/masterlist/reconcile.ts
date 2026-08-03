// scripts/template-load/src/masterlist/reconcile.ts
import { assetTypeCodeForModel } from './mapping';
import { MasterlistRow } from './parse';

export interface Reconciliation {
  row: MasterlistRow;
  assetTypeCode: string | null;
  /** Frequencies the plan schedules, in cascade order. */
  planned: string[];
  /** Frequencies the form defines. */
  formDefines: string[];
  /** In the form but not the plan — the operator is asked about each. */
  surplus: string[];
  /** In the plan but not the form — a hard error; the form cannot describe it. */
  missing: string[];
}

const ORDER = ['M1', 'M3', 'M6', 'Y'];
const sortFreq = (a: string, b: string) => ORDER.indexOf(a) - ORDER.indexOf(b);

/**
 * A machine visited thirteen times a year at 1M needs ONE 1M schedule rule,
 * not thirteen — `schedule_rule` is unique on (asset_document, frequency).
 * The visit list is a calendar; the rule set is its distinct frequencies.
 *
 * `missing` (planned but not in the form) is a HARD error: the form has no
 * items at that frequency, so the job would generate with nothing to fill.
 * Across Rev 21 it is empty for every machine — if it ever fires, the form and
 * the plan have genuinely diverged and a human must look.
 */
export function reconcile(
  rows: MasterlistRow[],
  formFrequencies: Record<string, string[]>,
): Reconciliation[] {
  return rows.map((row) => {
    const assetTypeCode = assetTypeCodeForModel(row.model, row.code);
    const planned: string[] = [...new Set(row.visits.map((v) => v.frequency))].sort(sortFreq);
    const formDefines = assetTypeCode ? (formFrequencies[assetTypeCode] ?? []) : [];
    return {
      row,
      assetTypeCode,
      planned,
      formDefines: [...formDefines].sort(sortFreq),
      surplus: formDefines.filter((f) => !planned.includes(f)).sort(sortFreq),
      missing: planned.filter((f) => !formDefines.includes(f)).sort(sortFreq),
    };
  });
}
