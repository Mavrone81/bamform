/**
 * Slice 13-TL — intermediate model for the TLP §6.1 YAML (BAMFORM-TLP-001).
 *
 * One `ParsedDocument` per source workbook. Field naming mirrors the API's
 * camelCase contract (shared/src/template.ts) because the YAML is the exact
 * payload the loader sends (PR-TLP-08/09); the YAML emitter renders the
 * TLP §6.1 snake_case key names.
 */

export type Frequency = 'M1' | 'M3' | 'M6' | 'Y';
export type SpecType = 'RANGE' | 'TOLERANCE' | 'PASS_FAIL' | 'TEXT';

/**
 * Register codes: B-01..B-09 are TLP §3's dispositioned defects; N-01.. are
 * the FURTHER source anomalies found by this slice's extraction, each
 * requiring client review in the AC-01 evidence pack (never silently
 * decided).
 */
export type AmbiguityCode =
  | 'B-01' // formula errors in Revision History header (docs 1, 9)
  | 'B-02' // revision letter gap (doc 1: 0,A,C,D,E — B absent)
  | 'B-03' // revision history dates out of chronological order
  | 'B-04' // doc 4 '95 - 28 g' — corrected to 95–105 g by client revision D
  | 'B-06' // worksheet name copied from another document (doc 6)
  | 'N-01' // doc 4 ' -295 - -305' — high-to-low printed range, no unit; NOT dispositioned
  | 'N-02' // doc 6 '6.4 - 7,1 counts/gram' — comma decimal
  | 'N-03' // doc 6 PRS Calibration prints the 'XY =' spec line twice (evident intent YX)
  | 'N-04' // doc 11 unnumbered instruction row + numbering skip; source has 11 rows, TLP counted 10 (145 total)
  | 'N-05' // doc 4: TLP §5.1 says 21 measurements; the source sheet has 20
  | 'N-06' // doc 5 USL/LSL columns inconsistently ordered + dual machine-variant table modelling
  | 'N-07' // stray out-of-grid cells (doc 5 Q38, doc 6 AA53) — not loaded
  | 'N-08' // qualitative / single-value specs loaded as TEXT (doc 6: 'Optimal', '35mm Plate', '75 mils')
  | 'N-09' // cosmetic worksheet-name anomalies in other documents ('CE ', 'Bachelor Bump BD01')
  | 'N-10'; // printed item numbering skips 9 (docs 5, 6, 11) — loaded verbatim

export interface Ambiguity {
  code: AmbiguityCode;
  message: string;
  /** Source cell references involved, e.g. "sheet1!J66". */
  cells: string[];
}

export interface RevisionHistoryEntry {
  /** Verbatim, including doc 5's trailing-space 'B '. */
  code: string;
  /** ISO date converted from the Excel serial; raw text if not a serial. */
  date: string;
  details: string;
  revisedBy: string;
  approvedBy: string;
}

export interface ParsedItem {
  /** The item number the system stores (INT). */
  itemNo: number;
  /** The number as printed on the form; null = the row has no printed number (doc 11). */
  printedNo: string | null;
  frequency: Frequency;
  /** Edge-trimmed, interior verbatim (the TLP §6.1 example trims edges). */
  instruction: string;
  stableKey: string;
  displayOrder: number;
  sourceRow: number;
}

export interface ParsedMeasurement {
  section: string | null;
  description: string;
  unit: string | null;
  specType: SpecType;
  lowerLimit: number | null;
  upperLimit: number | null;
  nominal: number | null;
  tolerance: number | null;
  /** What the rendered record shows. Verbatim (edge-trimmed) unless corrected/synthesised. */
  specDisplay: string;
  /** Set when specDisplay was corrected (B-04) — the defective source text. */
  sourceSpecDisplay?: string;
  /** Set when the display was synthesised from table columns (LCL/UCL, USL/LSL, Pass/Fail columns). */
  synthesizedDisplay?: boolean;
  /** Client-decision reference when a correction was applied (e.g. 'B-04 …'). */
  correction?: string;
  /** PR-TLP-05: why the spec could not be parsed into limits (TEXT escalations). */
  unparsedReason?: string;
  stableKey: string;
  displayOrder: number;
  sourceRow: number;
  sourceCells: string[];
}

export interface StandingContent {
  specialTools: string | null;
  partsRequired: { partNo?: string; description?: string; qty?: string; remarks?: string }[];
  ppe: string[];
  safety: string | null;
  procedure: string | null;
  remarks: string | null;
}

export interface ParsedDocument {
  documentNumber: string;
  title: string;
  assetTypeCode: string;
  assetTypeName: string;
  /** Revision printed in the source title block. */
  printedRevision: string;
  /**
   * Revision code the load creates as CURRENT. Equal to printedRevision for
   * every document except doc 4, which loads as client revision 'D' (the
   * B-04 correction — slice brief §0 / TLP §3 option (a)).
   */
  loadRevision: string;
  sourceFile: string;
  sourceSha256: string;
  /** Informational only (TLP §4.1) — shown in evidence, not loaded. */
  frequencyBanner: string | null;
  /** Machine columns on the checklist header (TLP §2), e.g. AW01–AW04 / BD01 / Status. */
  machineColumns: string[];
  sheetName: string;
  revisionHistory: RevisionHistoryEntry[];
  standingContent: StandingContent;
  /** AC-01 traceability: standing-content field → source cell range on sheet 1. */
  standingContentSources: Record<string, string>;
  items: ParsedItem[];
  measurements: ParsedMeasurement[];
  /** Human-readable notes carried into the YAML `notes:` block. */
  notes: string[];
  /** Machine-captured register entries for the AC-01 evidence pack. */
  ambiguities: Ambiguity[];
}
