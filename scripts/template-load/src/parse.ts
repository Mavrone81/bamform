/**
 * Slice 13-TL — parse the twelve real PM workbooks into the TLP §6.1
 * intermediate model (BAMFORM-TLP-001 §4 mapping rules).
 *
 * The twelve documents share one printed layout family (title block,
 * standing-content blocks, checklist, signature block, remarks footer,
 * optional measurement table), located here by LABEL ANCHORS rather than
 * fixed row numbers, because the row offsets differ per document. The
 * measurement tables have four distinct layouts, declared per document in
 * `DOC_CONFIG` — these are twelve KNOWN documents (TLP §2), not arbitrary
 * spreadsheets, and a declared configuration is reviewable in a way
 * heuristics are not.
 *
 * NOTHING is silently corrected: every anomaly the parse encounters is
 * captured as an `Ambiguity` (TLP §3 B-codes, plus the N-codes this slice's
 * extraction uncovered) and surfaces in the AC-01 evidence pack.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  Ambiguity,
  AmbiguityCode,
  Frequency,
  ParsedDocument,
  ParsedItem,
  ParsedMeasurement,
  RevisionHistoryEntry,
  StandingContent,
} from './model';
import { parseSpec } from './spec';
import { excelSerialToIsoDate, readWorkbook, type Sheet } from './xlsx';

// ---------------------------------------------------------------------------
// Per-document configuration (TLP §2 inventory + §5 per-document notes)
// ---------------------------------------------------------------------------

type MeasurementLayout =
  | { kind: 'none' }
  | { kind: 'section-table' } // docs 4, 6: No/Section/Description/Specification columns
  | { kind: 'dual-variant' } // doc 5: USL/LSL pairs for two machine variants
  | { kind: 'lcl-ucl'; unit: string } // doc 8: explicit LCL/UCL columns (unit per TLP §4.2)
  | { kind: 'besi-da-passfail' }; // doc 1: inline curing oven Pass/Fail block

interface SpecCorrection {
  /** sheet1 cell holding the defective text. */
  cell: string;
  sourceText: string;
  correctedDisplay: string;
  lowerLimit: number;
  upperLimit: number;
  unit: string;
  reference: string;
}

interface DocConfig {
  assetTypeCode: string;
  assetTypeName: string;
  measurementLayout: MeasurementLayout;
  /** Doc 11: the source numbering is defective (unnumbered row) — renumber positionally. */
  positionalItemNumbers?: boolean;
  /** Doc 4: load as this revision code (client-decided correction). */
  loadRevisionOverride?: { code: string; reason: string };
  corrections?: SpecCorrection[];
  /** TLP §5.1 stated measurement count, asserted against the source (N-05). */
  tlpMeasurementCount?: number;
  /** TLP §2 stated item count, asserted against the source (N-04). */
  tlpItemCount?: number;
}

const DOC_CONFIG: Record<string, DocConfig> = {
  'CE 95 010 00 01': {
    assetTypeCode: 'BESI_DIE_ATTACH',
    assetTypeName: 'BESI Die Attach',
    measurementLayout: { kind: 'besi-da-passfail' },
    tlpItemCount: 18,
  },
  'CE 95 012 00 01': {
    assetTypeCode: 'EMERALD_PICK_PLACE',
    assetTypeName: 'Emerald Pick and Place',
    measurementLayout: { kind: 'none' },
    tlpItemCount: 6,
  },
  'CE 95 012 00 02': {
    assetTypeCode: 'POWATEC_MOUNTING',
    assetTypeName: 'Powatec Mounting',
    measurementLayout: { kind: 'none' },
    tlpItemCount: 4,
  },
  'CE 95 020 00 01': {
    assetTypeCode: 'ASM_WIRE_BOND',
    assetTypeName: 'ASM Wire Bond',
    measurementLayout: { kind: 'section-table' },
    tlpItemCount: 14,
    tlpMeasurementCount: 21,
    loadRevisionOverride: {
      code: 'D',
      reason:
        'B-04: Bond Force Verification Input Force 100g specification printed as "95 - 28 g" ' +
        '(inverted, INV-04). Client decision (TLP §3 option (a)): corrected to 95 - 105 g and ' +
        'loaded as new revision D through the normal authoring workflow.',
    },
    corrections: [
      {
        cell: 'J66',
        sourceText: '95 - 28 g',
        correctedDisplay: '95 - 105 g',
        lowerLimit: 95,
        upperLimit: 105,
        unit: 'g',
        reference: 'B-04 (client revision D)',
      },
    ],
  },
  'CE 95 020 00 02': {
    assetTypeCode: 'BESI_ESEC_WIRE_BOND',
    assetTypeName: 'Besi Esec Wire Bond',
    measurementLayout: { kind: 'dual-variant' },
    tlpItemCount: 15,
  },
  'CE 95 020 00 03': {
    assetTypeCode: 'KNS_WIRE_BOND',
    assetTypeName: 'KNS Wire Bond',
    measurementLayout: { kind: 'section-table' },
    tlpItemCount: 15,
  },
  'CE 95 030 00 01': {
    assetTypeCode: 'MB_ENCAPSULATION',
    assetTypeName: 'MB Encapsulation',
    measurementLayout: { kind: 'none' },
    tlpItemCount: 13,
  },
  'CE 95 030 00 03': {
    assetTypeCode: 'PRE_MIXER',
    assetTypeName: 'Pre-mixer machine',
    measurementLayout: { kind: 'lcl-ucl', unit: 'mbar' },
    tlpItemCount: 9,
  },
  'CE 95 043 00 01': {
    assetTypeCode: 'BUMP_DISPENSING',
    assetTypeName: 'Bump Dispensing',
    measurementLayout: { kind: 'none' },
    tlpItemCount: 18,
  },
  'CE 95 050 00 01': {
    assetTypeCode: 'MB_E_TEST',
    assetTypeName: 'MB E-Test',
    measurementLayout: { kind: 'none' },
    tlpItemCount: 10,
  },
  'CE 95 050 00 03': {
    assetTypeCode: 'OS_LOADING',
    assetTypeName: 'OS Loading',
    measurementLayout: { kind: 'none' },
    positionalItemNumbers: true,
    tlpItemCount: 10,
  },
  'CE 95 055 00 01': {
    assetTypeCode: 'AVS_35',
    assetTypeName: 'AVS 35',
    measurementLayout: { kind: 'none' },
    tlpItemCount: 13,
  },
};

const FREQUENCY_MAP: Record<string, Frequency> = { '1M': 'M1', '3M': 'M3', '6M': 'M6', Y: 'Y' };

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

interface Grid {
  /** row number → column letter → raw cell text */
  rows: Map<number, Map<string, string>>;
  rowNumbers: number[]; // sorted ascending
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function toGrid(sheet: Sheet): Grid {
  const rows = new Map<number, Map<string, string>>();
  for (const [ref, value] of Object.entries(sheet.cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    const row = Number(m[2]);
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)!.set(m[1], value);
  }
  return { rows, rowNumbers: [...rows.keys()].sort((a, b) => a - b) };
}

function cell(grid: Grid, row: number, col: string): string | undefined {
  return grid.rows.get(row)?.get(col);
}

function cellTrim(grid: Grid, row: number, col: string): string {
  return (cell(grid, row, col) ?? '').trim();
}

/** First row ≥ from whose column `col` (trimmed) satisfies `test`. */
function findRow(
  grid: Grid,
  col: string,
  test: (value: string) => boolean,
  from = 1,
): number | undefined {
  return grid.rowNumbers.find((r) => r >= from && test(cellTrim(grid, r, col)));
}

// ---------------------------------------------------------------------------
// Stable keys (PR-TLP-06)
// ---------------------------------------------------------------------------

function slug(textValue: string): string {
  return textValue
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

class StableKeys {
  private readonly used = new Set<string>();
  constructor(private readonly documentNumber: string) {}

  next(textValue: string): string {
    const prefix = this.documentNumber.replace(/\s+/g, '-');
    const base = `${prefix}::${slug(textValue) || 'untitled'}`;
    let key = base;
    for (let i = 2; this.used.has(key); i++) {
      key = `${base}-${i}`;
    }
    this.used.add(key);
    return key;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseFormWorkbook(path: string): ParsedDocument {
  const fileBuffer = readFileSync(path);
  const workbook = readWorkbook(path);
  const sheet1 = toGrid(workbook.sheets[0]);
  const historySheet = workbook.sheets.find((s) => s.name === 'Revision History');
  if (!historySheet) {
    throw new Error(`${path}: no "Revision History" sheet`);
  }
  const sheet2 = toGrid(historySheet);

  const ambiguities: Ambiguity[] = [];
  const notes: string[] = [];
  const note = (code: AmbiguityCode, message: string, cells: string[] = []) => {
    ambiguities.push({ code, message, cells });
    notes.push(`${code}: ${message}`);
  };

  // --- Title block -------------------------------------------------------
  const titleRow = findRow(sheet1, 'C', (v) => v === 'Document Title:');
  if (titleRow === undefined) throw new Error(`${path}: title block not found`);
  const valueRow = titleRow + 1;
  const title = cellTrim(sheet1, valueRow, 'C');
  const documentNumber = cellTrim(sheet1, valueRow, 'K');
  const printedRevision = cellTrim(sheet1, valueRow, 'M');
  if (!title || !documentNumber || !printedRevision) {
    throw new Error(`${path}: incomplete title block (row ${valueRow})`);
  }
  const config = DOC_CONFIG[documentNumber];
  if (!config) throw new Error(`${path}: unknown document number "${documentNumber}"`);

  const sheetName = workbook.sheets[0].name;
  if (sheetName.trim() !== documentNumber) {
    if (documentNumber === 'CE 95 020 00 03') {
      note(
        'B-06',
        `worksheet is named "${sheetName}" — copied from CE 95 020 00 01 (TLP §3 B-06). ` +
          'Cosmetic; the document number is taken from the title block.',
      );
    } else {
      note(
        'N-09',
        `worksheet is named "${sheetName}", not the document number. Cosmetic; ` +
          'the document number is taken from the title block.',
      );
    }
  }

  // --- Frequency banner (informational only, TLP §4.1) -------------------
  const bannerParts: string[] = [];
  for (let r = valueRow + 1; r <= valueRow + 3; r++) {
    for (const col of ['C', 'D', 'H', 'L']) {
      const v = cellTrim(sheet1, r, col);
      if (/\((?:1M|3M|6M|Y)\)/.test(v)) bannerParts.push(v.replace(/\s+/g, ' '));
    }
  }
  const frequencyBanner = bannerParts.length ? bannerParts.join(' ') : null;

  // --- Standing content --------------------------------------------------
  const anchorRow = (test: (v: string) => boolean, from = 1) => findRow(sheet1, 'A', test, from);

  const toolsRow = anchorRow((v) => v === 'Special Tools Required:');
  const specialTools = toolsRow !== undefined ? cellTrim(sheet1, toolsRow, 'D') || null : null;

  const partsRow = anchorRow((v) => v === 'Parts Required:');
  const ppeRow = anchorRow((v) => v === 'PPE Required:');
  const partsRequired: StandingContent['partsRequired'] = [];
  if (partsRow !== undefined && ppeRow !== undefined) {
    for (let r = partsRow + 1; r < ppeRow; r++) {
      const partNo = cellTrim(sheet1, r, 'D');
      const description = cellTrim(sheet1, r, 'G');
      const qty = cellTrim(sheet1, r, 'L');
      const remarks = cellTrim(sheet1, r, 'M');
      if (partNo || description || qty || remarks) {
        partsRequired.push({ partNo, description, qty, remarks });
      }
    }
  }

  const ppe: string[] = [];
  if (ppeRow !== undefined) {
    for (let r = ppeRow; r <= ppeRow + 12; r++) {
      const index = cellTrim(sheet1, r, 'C');
      const value = cellTrim(sheet1, r, 'D');
      if (/^\d+$/.test(index) && value) ppe.push(value);
      else if (r > ppeRow) break;
    }
  }

  const safetyRow = anchorRow((v) => v.startsWith('Safety:'));
  const safety = safetyRow !== undefined ? cellTrim(sheet1, safetyRow, 'C') || null : null;

  let checklistHeader: number | undefined;
  for (const r of sheet1.rowNumbers) {
    if (cellTrim(sheet1, r, 'A') === 'No' && cellTrim(sheet1, r, 'B') === 'Freq.') {
      checklistHeader = r;
      break;
    }
  }
  if (checklistHeader === undefined) throw new Error(`${path}: checklist header not found`);

  const procedureRow = anchorRow((v) => v.startsWith('Procedure') || v === 'Note:');
  const procedureLines: string[] = [];
  if (procedureRow !== undefined) {
    for (let r = procedureRow; r < checklistHeader; r++) {
      const line = cellTrim(sheet1, r, 'C');
      if (line) procedureLines.push(line);
      else if (r > procedureRow) break;
    }
  }
  const procedure = procedureLines.length ? procedureLines.join('\n') : null;

  const remarksRow = anchorRow((v) => v.startsWith('Remarks:'), checklistHeader);
  let remarks: string | null = null;
  if (remarksRow !== undefined) {
    const rawRemarks = cell(sheet1, remarksRow, 'A') ?? '';
    remarks = rawRemarks.replace(/^\s*Remarks:\s*/, '').trimEnd() || null;
  }

  // AC-01 traceability: where each standing-content field came from.
  const standingContentSources: Record<string, string> = {};
  if (toolsRow !== undefined) standingContentSources.specialTools = `D${toolsRow}`;
  if (partsRow !== undefined && ppeRow !== undefined) {
    standingContentSources.partsRequired = `D${partsRow + 1}:M${ppeRow - 1}`;
  }
  if (ppeRow !== undefined && ppe.length > 0) {
    standingContentSources.ppe = `D${ppeRow}:D${ppeRow + ppe.length - 1}`;
  }
  if (safetyRow !== undefined) standingContentSources.safety = `C${safetyRow}`;
  if (procedureRow !== undefined && procedureLines.length > 0) {
    standingContentSources.procedure = `C${procedureRow}:C${procedureRow + procedureLines.length - 1}`;
  }
  if (remarksRow !== undefined) standingContentSources.remarks = `A${remarksRow}`;

  // --- Checklist items ---------------------------------------------------
  const machineColumns: string[] = [];
  for (const col of ['M', 'N', 'O', 'P']) {
    const v = cellTrim(sheet1, checklistHeader, col);
    if (v) machineColumns.push(v);
  }

  const endAnchor = anchorRow((v) => v.startsWith('Maintenance Performed by'), checklistHeader);
  if (endAnchor === undefined) throw new Error(`${path}: signature block not found`);

  const keys = new StableKeys(documentNumber);
  const items: ParsedItem[] = [];
  let missingNumberRows = 0;
  for (const r of sheet1.rowNumbers) {
    if (r <= checklistHeader || r >= endAnchor) continue;
    const instructionRaw = cell(sheet1, r, 'C');
    if (instructionRaw === undefined || instructionRaw.trim() === '') continue;
    const printedNoRaw = cellTrim(sheet1, r, 'A');
    const printedNo = printedNoRaw === '' ? null : printedNoRaw;
    if (printedNo === null) missingNumberRows++;
    const freqRaw = cellTrim(sheet1, r, 'B');
    const frequency = FREQUENCY_MAP[freqRaw];
    if (!frequency) throw new Error(`${path}: row ${r}: unknown frequency "${freqRaw}"`);
    const instruction = instructionRaw.trim();
    const position = items.length + 1;
    let itemNo: number;
    if (config.positionalItemNumbers) {
      itemNo = position;
    } else {
      if (printedNo === null || !/^\d+$/.test(printedNo)) {
        throw new Error(`${path}: row ${r}: unusable printed item number "${printedNoRaw}"`);
      }
      itemNo = Number(printedNo);
    }
    items.push({
      itemNo,
      printedNo,
      frequency,
      instruction,
      stableKey: keys.next(instruction),
      displayOrder: position - 1,
      sourceRow: r,
    });
  }

  if (config.positionalItemNumbers) {
    note(
      'N-04',
      `the checklist has ${items.length} instruction rows but the printed numbering is ` +
        `defective: one row ("${items.find((i) => i.printedNo === null)?.instruction ?? ''}") has ` +
        'no printed number and the printed sequence skips 9. Items are loaded with positional ' +
        `numbers 1..${items.length}; the printed numbers are preserved in the AC-01 evidence. ` +
        `TLP §2 counted ${config.tlpItemCount} items for this document (and 145 in total) — the ` +
        `source sheet has ${items.length} (146 in total). Client to confirm.`,
      items.filter((i) => i.printedNo === null).map((i) => `sheet1!A${i.sourceRow}`),
    );
  } else if (config.tlpItemCount !== undefined && items.length !== config.tlpItemCount) {
    note(
      'N-04',
      `TLP §2 counts ${config.tlpItemCount} items; the source sheet has ${items.length}.`,
    );
  }
  if (missingNumberRows > 0 && !config.positionalItemNumbers) {
    throw new Error(`${path}: ${missingNumberRows} checklist rows have no printed number`);
  }
  const printedNumbers = items
    .map((i) => (i.printedNo && /^\d+$/.test(i.printedNo) ? Number(i.printedNo) : null))
    .filter((n): n is number => n !== null);
  const skips = printedNumbers.filter((n, i) => i > 0 && n !== printedNumbers[i - 1] + 1);
  if (skips.length > 0) {
    note(
      'N-10',
      `printed item numbering is non-contiguous (skips before ${skips.join(', ')}) — ` +
        'loaded verbatim as printed.',
    );
  }

  // --- Measurements ------------------------------------------------------
  const measurements = parseMeasurements(sheet1, config, keys, note, endAnchor);
  if (
    config.tlpMeasurementCount !== undefined &&
    measurements.length !== config.tlpMeasurementCount
  ) {
    note(
      'N-05',
      `TLP §5.1 states ${config.tlpMeasurementCount} calibration measurements; the source sheet ` +
        `has ${measurements.length} measurement rows. The source wins; discrepancy recorded.`,
    );
  }

  // --- Stray out-of-grid cells ------------------------------------------
  for (const r of sheet1.rowNumbers) {
    for (const [col, v] of sheet1.rows.get(r)!) {
      if (colIndex(col) > colIndex('P') && v.trim() !== '') {
        note(
          'N-07',
          `stray cell outside the form grid: ${col}${r} = ${JSON.stringify(v)} — not loaded.`,
          [`${col}${r}`],
        );
      }
    }
  }

  // --- Revision history (sheet 2) ---------------------------------------
  const revisionHistory: RevisionHistoryEntry[] = [];
  const errorCells: string[] = [];
  for (const r of sheet2.rowNumbers) {
    for (const [col, v] of sheet2.rows.get(r)!) {
      if (v.startsWith('#ERROR:')) errorCells.push(`${col}${r}`);
    }
  }
  if (errorCells.length > 0) {
    note(
      'B-01',
      `formula error(s) in the Revision History header (${errorCells.join(', ')}) — header ` +
        'values re-entered from the intact title block (TLP §3 B-01).',
      errorCells,
    );
  }

  let historyHeader: number | undefined;
  for (const r of sheet2.rowNumbers) {
    if (cellTrim(sheet2, r, 'A') === 'Date' && cellTrim(sheet2, r, 'B') === 'Revision') {
      historyHeader = r;
      break;
    }
  }
  if (historyHeader === undefined) throw new Error(`${path}: revision history header not found`);
  for (const r of sheet2.rowNumbers) {
    if (r <= historyHeader) continue;
    const codeRaw = cell(sheet2, r, 'B');
    const dateRaw = cellTrim(sheet2, r, 'A');
    if (dateRaw === 'Internal Document' || codeRaw === undefined || codeRaw.trim() === '') {
      continue;
    }
    const date = /^\d+$/.test(dateRaw) ? excelSerialToIsoDate(Number(dateRaw)) : dateRaw;
    revisionHistory.push({
      code: codeRaw, // verbatim — doc 5's 'B ' keeps its trailing space
      date,
      details: (cell(sheet2, r, 'C') ?? '').trim(),
      revisedBy: cellTrim(sheet2, r, 'D'),
      approvedBy: cellTrim(sheet2, r, 'E'),
    });
  }

  // B-02: gap in the revision letter sequence (0, A, B, C, ...).
  const ordinals = revisionHistory.map((entry) => {
    const c = entry.code.trim();
    return c === '0' ? 0 : c.length === 1 ? c.charCodeAt(0) - 64 : NaN;
  });
  const hasGap = ordinals.some((o, i) => i > 0 && !Number.isNaN(o) && o !== ordinals[i - 1] + 1);
  if (hasGap) {
    note(
      'B-02',
      `revision codes run ${revisionHistory.map((e) => e.code.trim()).join(', ')} — the sequence ` +
        'has a gap. Client answered "no need" (Q8): loaded with contiguous sequence ordinals ' +
        'while the historical letters are retained; the gap stays visible here and in the ' +
        'revision history (TLP §3 B-02, PR-TLP-03).',
    );
  }

  // B-03 class: revision dates out of chronological order (as printed).
  const isoDates = revisionHistory.map((e) => e.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const outOfOrder = isoDates.some((d, i) => i > 0 && d < isoDates[i - 1]);
  if (outOfOrder) {
    note(
      'B-03',
      `revision history dates are out of chronological order as printed ` +
        `(${revisionHistory.map((e) => `${e.code.trim()}=${e.date}`).join(', ')}). Loaded in ` +
        'printed order with dates AS PRINTED; not silently reordered (TLP §3 B-03, PR-TLP-03).' +
        (documentNumber === 'CE 95 055 00 01'
          ? ''
          : ' NOTE: TLP §3 flags this defect only on CE 95 055 00 01; the same anomaly exists here.'),
    );
  }

  if (config.loadRevisionOverride) {
    notes.push(`B-04 load revision: ${config.loadRevisionOverride.reason}`);
  }

  return {
    documentNumber,
    title,
    assetTypeCode: config.assetTypeCode,
    assetTypeName: config.assetTypeName,
    printedRevision,
    loadRevision: config.loadRevisionOverride?.code ?? printedRevision,
    sourceFile: basename(path),
    sourceSha256: createHash('sha256').update(fileBuffer).digest('hex'),
    frequencyBanner,
    machineColumns,
    sheetName,
    revisionHistory,
    standingContent: { specialTools, partsRequired, ppe, safety, procedure, remarks },
    standingContentSources,
    items,
    measurements,
    notes,
    ambiguities,
  };
}

// ---------------------------------------------------------------------------
// Measurement layouts
// ---------------------------------------------------------------------------

type NoteFn = (code: AmbiguityCode, message: string, cells?: string[]) => void;

function parseMeasurements(
  sheet1: Grid,
  config: DocConfig,
  keys: StableKeys,
  note: NoteFn,
  afterRow: number,
): ParsedMeasurement[] {
  const layout = config.measurementLayout;
  switch (layout.kind) {
    case 'none':
      return [];
    case 'section-table':
      return parseSectionTable(sheet1, config, keys, note, afterRow);
    case 'dual-variant':
      return parseDualVariant(sheet1, keys, note, afterRow);
    case 'lcl-ucl':
      return parseLclUcl(sheet1, layout.unit, keys, note, afterRow);
    case 'besi-da-passfail':
      return parseBesiDaPassFail(sheet1, keys, note, afterRow);
  }
}

function measurementHeaderRow(sheet1: Grid, afterRow: number): number {
  for (const r of sheet1.rowNumbers) {
    if (r <= afterRow) continue;
    if (cellTrim(sheet1, r, 'A') === 'No' || cellTrim(sheet1, r, 'A') === 'No ') {
      if (cellTrim(sheet1, r, 'B').startsWith('Section')) return r;
    }
  }
  throw new Error('measurement table header not found');
}

function tableEndRow(sheet1: Grid, headerRow: number): number {
  for (const r of sheet1.rowNumbers) {
    if (r > headerRow && cellTrim(sheet1, r, 'A') === 'Internal Document') return r;
  }
  return Math.max(...sheet1.rowNumbers) + 1;
}

/** Docs 4 and 6 — No/Section/Description(E)/Specification(J) with grouped sections. */
function parseSectionTable(
  sheet1: Grid,
  config: DocConfig,
  keys: StableKeys,
  note: NoteFn,
  afterRow: number,
): ParsedMeasurement[] {
  const header = measurementHeaderRow(sheet1, afterRow);
  const end = tableEndRow(sheet1, header);

  // Group rows by the numbered Section column (blank inherits — TLP §4.1);
  // multi-row section labels within one numbered group are space-joined.
  interface Row {
    r: number;
    no: string;
    sectionCell: string;
    desc: string | undefined;
    spec: string | undefined;
  }
  const rows: Row[] = [];
  for (const r of sheet1.rowNumbers) {
    if (r <= header || r >= end) continue;
    rows.push({
      r,
      no: cellTrim(sheet1, r, 'A'),
      sectionCell: cellTrim(sheet1, r, 'B'),
      desc: cell(sheet1, r, 'E'),
      spec: cell(sheet1, r, 'J'),
    });
  }

  // Build groups: a new group starts at a row with a non-empty No.
  const groups: Row[][] = [];
  for (const row of rows) {
    if (row.no !== '' || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(row);
  }

  const corrections = new Map((config.corrections ?? []).map((c) => [c.cell, c]));
  const out: ParsedMeasurement[] = [];
  for (const group of groups) {
    const groupLabels = group.map((row) => row.sectionCell).filter((s) => s !== '');
    const sectionLabel = groupLabels.join(' ') || null;
    if (groupLabels.length > 1) {
      // N-11 (review finding T-3) — TLP §4.1 says the Section column is
      // "Verbatim; blank inherits the section above". This parser instead
      // groups by the numbered No column and space-joins every label in the
      // group. For a label that WRAPPED across rows (e.g. "Wire Clamp
      // Calibration" / "Wire Clamp Force" / "Verification") the join is the
      // correct reading; where a group genuinely contains TWO distinct
      // sections (doc 4 rows 58-63: "BH Setup & Calibration" then "Heater
      // Block Setup", which TLP §5.1 lists separately) the inherit rule
      // would instead split them. The hybrid label is what a technician
      // sees, so this is escalated rather than silently chosen.
      note(
        'N-11',
        `section label "${sectionLabel}" was space-joined from ${groupLabels.length} printed ` +
          `labels (${groupLabels.map((l) => `"${l}"`).join(', ')}) in the group starting at row ` +
          `${group[0].r}. TLP §4.1's rule is "verbatim; blank inherits the section above", which ` +
          `for a genuinely two-section group would instead read ${groupLabels
            .map((l) => `"${l}"`)
            .join(
              ' then ',
            )} as SEPARATE sections. Where the label merely wrapped across rows the ` +
          'join is correct. Client to confirm per group: accept the joined label, or split per ' +
          '§4.1 (a parser change + regeneration).',
        group.filter((row) => row.sectionCell !== '').map((row) => `B${row.r}`),
      );
    }
    let lastDescription: string | null = null;
    for (const row of group) {
      const specRaw = row.spec;
      if (specRaw === undefined || specRaw.trim() === '') continue;
      const descTrim = row.desc?.trim() ?? '';
      const description: string | null = descTrim !== '' ? descTrim : lastDescription;
      if (description === null) {
        throw new Error(`measurement row ${row.r} has a specification but no description`);
      }
      lastDescription = description;

      const correction = corrections.get(`J${row.r}`);
      let m: ParsedMeasurement;
      if (correction) {
        if (specRaw.trim() !== correction.sourceText) {
          throw new Error(
            `correction for J${row.r} expected source text ${JSON.stringify(
              correction.sourceText,
            )} but found ${JSON.stringify(specRaw.trim())} — source file changed?`,
          );
        }
        m = {
          section: sectionLabel,
          description,
          unit: correction.unit,
          specType: 'RANGE',
          lowerLimit: correction.lowerLimit,
          upperLimit: correction.upperLimit,
          nominal: null,
          tolerance: null,
          specDisplay: correction.correctedDisplay,
          sourceSpecDisplay: correction.sourceText,
          correction: correction.reference,
          stableKey: keys.next(description),
          displayOrder: out.length,
          sourceRow: row.r,
          sourceCells: [`E${row.r}`, `J${row.r}`],
        };
        note(
          'B-04',
          `specification at J${row.r} printed as "${correction.sourceText}" — loaded as ` +
            `"${correction.correctedDisplay}" per ${correction.reference}.`,
          [`J${row.r}`],
        );
      } else {
        const parsed = parseSpec(specRaw);
        m = {
          section: sectionLabel,
          description,
          unit: parsed.unit,
          specType: parsed.specType,
          lowerLimit: parsed.lowerLimit,
          upperLimit: parsed.upperLimit,
          nominal: parsed.nominal,
          tolerance: parsed.tolerance,
          specDisplay: specRaw.trim(),
          stableKey: keys.next(description),
          displayOrder: out.length,
          sourceRow: row.r,
          sourceCells: [`E${row.r}`, `J${row.r}`],
        };
        if (parsed.unparsedReason) m.unparsedReason = parsed.unparsedReason;
      }
      out.push(m);
    }
  }

  registerSectionTableEscalations(out, note);
  return out;
}

/** Shared escalation notes for TEXT specs and duplicated labels. */
function registerSectionTableEscalations(measurements: ParsedMeasurement[], note: NoteFn): void {
  for (const m of measurements) {
    if (m.specType !== 'TEXT' || !m.unparsedReason) continue;
    const where = `sheet1!${m.sourceCells[1] ?? `row ${m.sourceRow}`}`;
    if (m.unparsedReason.includes('high-to-low')) {
      note(
        'N-01',
        `"${m.description}" specification printed as "${m.specDisplay}" — high-to-low printed ` +
          'range with no unit; inverted per INV-04 and NOT client-dispositioned (unlike B-04). ' +
          'Loaded as spec_type TEXT verbatim (the B-04 option (b) mechanism), pending a client ' +
          'decision. PR-TLP-05.',
        [m.sourceCells[1]],
      );
    } else if (m.unparsedReason.includes('comma-decimal')) {
      note(
        'N-02',
        `"${m.description}" specification printed as "${m.specDisplay}" — comma decimal ` +
          '(evident intent 7.1). Loaded as spec_type TEXT verbatim pending a client decision. ' +
          `(${where})`,
        [m.sourceCells[1]],
      );
    } else {
      note(
        'N-08',
        `"${m.description}" specification "${m.specDisplay}" is ${m.unparsedReason} — loaded as ` +
          `spec_type TEXT verbatim; client to confirm the intended judgement. (${where})`,
        [m.sourceCells[1]],
      );
    }
  }

  // Duplicated spec labels within one description (doc 6 PRS 'XY =' twice).
  const byDescription = new Map<string, ParsedMeasurement[]>();
  for (const m of measurements) {
    const list = byDescription.get(m.description) ?? [];
    list.push(m);
    byDescription.set(m.description, list);
  }
  for (const [description, list] of byDescription) {
    const labels = list
      .map((m) => /^([A-Z]{2})\s*=/.exec(m.specDisplay)?.[1])
      .filter((l): l is string => l !== undefined);
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    if (dupes.length > 0) {
      note(
        'N-03',
        `"${description}" prints the spec line label "${dupes[0]} =" twice — evident intent is ` +
          'YX for one of them. Both lines loaded verbatim; client to confirm.',
        list.map((m) => m.sourceCells[1]),
      );
    }
  }
}

/** Doc 5 — USL/LSL pairs for ESEC 3100/plus (I,J) and ESEC 3200 (K,L). */
function parseDualVariant(
  sheet1: Grid,
  keys: StableKeys,
  note: NoteFn,
  afterRow: number,
): ParsedMeasurement[] {
  const header = measurementHeaderRow(sheet1, afterRow);
  const end = tableEndRow(sheet1, header);
  const variantRow = header + 1;
  const labelRow = header + 2;
  const variants = [
    { name: cellTrim(sheet1, variantRow, 'I'), uslCol: 'I', lslCol: 'J' },
    { name: cellTrim(sheet1, variantRow, 'K'), uslCol: 'K', lslCol: 'L' },
  ];
  if (
    cellTrim(sheet1, labelRow, 'I') !== 'USL' ||
    cellTrim(sheet1, labelRow, 'J') !== 'LSL' ||
    variants.some((v) => v.name === '')
  ) {
    throw new Error('dual-variant table: USL/LSL header rows not where expected');
  }

  const out: ParsedMeasurement[] = [];
  let section: string | null = null;
  const swapCells: string[] = [];
  for (const r of sheet1.rowNumbers) {
    if (r <= labelRow || r >= end) continue;
    const desc = cellTrim(sheet1, r, 'E');
    if (desc === '') continue;
    const sectionCell = cellTrim(sheet1, r, 'B');
    if (sectionCell !== '') section = sectionCell;
    const unitMatch = /\(([^)]+)\)\s*$/.exec(desc);
    const unit = unitMatch ? unitMatch[1] : null;

    for (const variant of variants) {
      const uslRaw = cellTrim(sheet1, r, variant.uslCol);
      const lslRaw = cellTrim(sheet1, r, variant.lslCol);
      if (uslRaw === '' || lslRaw === '') continue;
      const usl = Number(uslRaw);
      const lsl = Number(lslRaw);
      if (Number.isNaN(usl) || Number.isNaN(lsl)) {
        throw new Error(`dual-variant row ${r}: non-numeric USL/LSL "${uslRaw}"/"${lslRaw}"`);
      }
      // Column labelled USL sometimes holds the smaller endpoint — the
      // labels are inconsistent in the source (N-06). Both endpoints are
      // preserved; lower/upper are min/max so INV-04 always holds.
      if (usl < lsl) swapCells.push(`${variant.uslCol}${r}`);
      const description = `${desc} — ${variant.name}`;
      out.push({
        section,
        description,
        unit,
        specType: 'RANGE',
        lowerLimit: Math.min(usl, lsl),
        upperLimit: Math.max(usl, lsl),
        nominal: null,
        tolerance: null,
        specDisplay: `USL ${uslRaw} / LSL ${lslRaw}`,
        synthesizedDisplay: true,
        stableKey: keys.next(description),
        displayOrder: out.length,
        sourceRow: r,
        sourceCells: [`E${r}`, `${variant.uslCol}${r}`, `${variant.lslCol}${r}`],
      });
    }
  }

  note(
    'N-06',
    'the calibration table carries TWO machine-variant limit pairs (ESEC 3100 / plus and ' +
      'ESEC 3200) in explicit USL/LSL columns. Loaded as two measurements per printed row ' +
      '(descriptions suffixed with the variant) so no limit is lost; a technician records the ' +
      "pair matching the machine's variant. " +
      (swapCells.length > 0
        ? `Additionally the USL/LSL column labels are inconsistently ordered in the source ` +
          `(the USL column holds the SMALLER endpoint at ${swapCells.join(
            ', ',
          )}); parsed limits use min/max so no inverted range is loaded. `
        : '') +
      'Client to confirm both the modelling and the intended labels.',
    swapCells,
  );
  return out;
}

/** Doc 8 — one measurement, explicit LCL/UCL columns (TLP §4.2, §5.4). */
function parseLclUcl(
  sheet1: Grid,
  unit: string,
  keys: StableKeys,
  note: NoteFn,
  afterRow: number,
): ParsedMeasurement[] {
  const header = measurementHeaderRow(sheet1, afterRow);
  const end = tableEndRow(sheet1, header);
  const labelRow = header + 1;
  if (cellTrim(sheet1, labelRow, 'I') !== 'LCL' || cellTrim(sheet1, labelRow, 'K') !== 'UCL') {
    throw new Error('LCL/UCL table: label row not where expected');
  }
  const out: ParsedMeasurement[] = [];
  for (const r of sheet1.rowNumbers) {
    if (r <= labelRow || r >= end) continue;
    const desc = cellTrim(sheet1, r, 'E');
    const lclRaw = cellTrim(sheet1, r, 'I');
    const uclRaw = cellTrim(sheet1, r, 'K');
    if (desc === '' && lclRaw === '' && uclRaw === '') continue;
    if (desc === '') continue; // trailing blank spec row (doc 8 R51 holds single spaces)
    const lower = Number(lclRaw);
    const upper = Number(uclRaw);
    if (Number.isNaN(lower) || Number.isNaN(upper)) {
      throw new Error(`LCL/UCL row ${r}: non-numeric limits "${lclRaw}"/"${uclRaw}"`);
    }
    out.push({
      section: cellTrim(sheet1, r, 'B') || null,
      description: desc,
      unit,
      specType: 'RANGE',
      lowerLimit: lower,
      upperLimit: upper,
      nominal: null,
      tolerance: null,
      specDisplay: `LCL ${lclRaw} / UCL ${uclRaw}`,
      synthesizedDisplay: true,
      stableKey: keys.next(desc),
      displayOrder: out.length,
      sourceRow: r,
      sourceCells: [`E${r}`, `I${r}`, `K${r}`],
    });
  }
  note(
    'N-08',
    'the record table prints bare LCL/UCL column values; spec_display is synthesised as ' +
      `"LCL n / UCL n" with unit "${unit}" (TLP §4.2's explicit-LCL/UCL row). ` +
      'Source cells shown in the evidence table.',
    out.flatMap((m) => m.sourceCells.slice(1)),
  );
  return out;
}

/** Doc 1 — inline curing oven Pass/Fail block (TLP §2: "Inline curing oven, Pass/Fail"). */
function parseBesiDaPassFail(
  sheet1: Grid,
  keys: StableKeys,
  note: NoteFn,
  afterRow: number,
): ParsedMeasurement[] {
  let headingRow: number | undefined;
  let recipeRow: number | undefined;
  for (const r of sheet1.rowNumbers) {
    if (r <= afterRow) continue;
    const a = cellTrim(sheet1, r, 'A');
    if (a.startsWith('Inline curing oven calibration record')) headingRow = r;
    if (a.startsWith('Recipe name')) recipeRow = r;
  }
  if (headingRow === undefined || recipeRow === undefined) {
    throw new Error('Besi Die Attach: inline curing oven block not found');
  }
  const section = cellTrim(sheet1, headingRow, 'A');
  const description = cellTrim(sheet1, recipeRow, 'A');
  note(
    'N-08',
    'the inline curing oven calibration block is free text with Pass/Fail tick columns; loaded ' +
      'as a single PASS_FAIL measurement whose spec_display ("Pass / Fail") is synthesised from ' +
      'those columns. Source cells shown in the evidence table.',
    [`A${headingRow}`, `A${recipeRow}`],
  );
  return [
    {
      section,
      description,
      unit: null,
      specType: 'PASS_FAIL',
      lowerLimit: null,
      upperLimit: null,
      nominal: null,
      tolerance: null,
      specDisplay: 'Pass / Fail',
      synthesizedDisplay: true,
      stableKey: keys.next(description),
      displayOrder: 0,
      sourceRow: recipeRow,
      sourceCells: [`A${headingRow}`, `A${recipeRow}`],
    },
  ];
}

// ---------------------------------------------------------------------------
// Directory entry point
// ---------------------------------------------------------------------------

export function parseAllForms(dir: string): ParsedDocument[] {
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'))
    .sort();
  if (files.length !== 12) {
    throw new Error(`expected exactly 12 source workbooks in ${dir}, found ${files.length}`);
  }
  return files.map((f) => parseFormWorkbook(join(dir, f)));
}
