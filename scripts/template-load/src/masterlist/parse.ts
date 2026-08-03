import { readWorkbook } from '../xlsx';

export interface PlannedVisit {
  workWeek: number;
  frequency: 'M1' | 'M3' | 'M6' | 'Y';
}
export interface MasterlistRow {
  /** Verbatim column A, whitespace-collapsed. */
  label: string;
  /** Text before `--`; without a separator, everything before the last token. */
  model: string;
  /**
   * The plant's machine code — text after `--`, or the LAST whitespace-delimited
   * token when there is no separator (`ConnX-Elite Lite KW01` -> `KW01`). This
   * becomes the asset's identifier in the register and prints on every record.
   */
  code: string;
  visits: PlannedVisit[];
}

const FREQ: Record<string, PlannedVisit['frequency']> = {
  '1M': 'M1',
  '3M': 'M3',
  '6M': 'M6',
  Y: 'Y',
};

const rowOf = (ref: string): number => Number(ref.replace(/[A-Z]+/g, ''));
const colOf = (ref: string): string => ref.replace(/\d+/g, '');

/**
 * `ML-S-MFT-00015` is a work-week matrix: row 4 carries week numbers across
 * the columns, row 5 month bands, and each machine is one row from row 6 with
 * a frequency in the cell for every week it is due.
 */
export function parseMasterlist(path: string): MasterlistRow[] {
  const sheet = readWorkbook(path).sheets[0];

  const weekOfColumn: Record<string, number> = {};
  for (const ref of Object.keys(sheet.cells)) {
    if (rowOf(ref) !== 4) continue;
    const week = Number(sheet.cells[ref]);
    if (Number.isInteger(week) && week >= 1 && week <= 53) weekOfColumn[colOf(ref)] = week;
  }

  const byRow = new Map<number, MasterlistRow>();
  for (const ref of Object.keys(sheet.cells)) {
    if (colOf(ref) !== 'A' || rowOf(ref) < 6) continue;
    const label = sheet.cells[ref].replace(/\s+/g, ' ').trim();
    if (label === '') continue;
    // Column A holds three shapes and all three must yield the plant's real
    // machine code, because that code becomes the asset's identifier in the
    // register and appears on every printed record:
    //
    //   `ESEC 2008 sc3 plus -- ED01`   separator present  -> ED01
    //   `ConnX-Elite Lite KW01`        no separator       -> KW01  (last token)
    //   `EP01`                         single token       -> EP01
    //
    // Reading the whole string as the code when there is no separator gives 18
    // machines identifiers like `ConnX-Elite Lite KW01` — wrong in the register
    // and wrong on the record.
    const sep = label.indexOf('--');
    let model: string;
    let code: string;
    if (sep !== -1) {
      model = label.slice(0, sep).trim();
      code = label.slice(sep + 2).trim();
    } else {
      const parts = label.split(/\s+/);
      code = parts[parts.length - 1];
      model = parts.length > 1 ? parts.slice(0, -1).join(' ') : label;
    }
    byRow.set(rowOf(ref), { label, model, code, visits: [] });
  }

  for (const ref of Object.keys(sheet.cells)) {
    const row = byRow.get(rowOf(ref));
    if (!row || colOf(ref) === 'A') continue;
    const week = weekOfColumn[colOf(ref)];
    const frequency = FREQ[sheet.cells[ref].trim()];
    // A cell that is neither under a week column nor a known frequency is
    // sheet furniture (notes, legend) — not a silent data loss.
    if (week === undefined || frequency === undefined) continue;
    row.visits.push({ workWeek: week, frequency });
  }

  return [...byRow.values()]
    .filter((r) => r.visits.length > 0)
    .map((r) => ({ ...r, visits: r.visits.sort((a, b) => a.workWeek - b.workWeek) }));
}
