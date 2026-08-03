// js-yaml (an existing api devDependency) ships no types and no @types
// package is installed; this file is compiled BOTH by
// scripts/template-load/tsconfig.json and per-file by ts-jest under
// api/tsconfig.jest.json, and a triple-slash reference is the one mechanism
// that carries the ambient module declaration into every consuming program
// without touching the api tsconfig includes — hence the targeted disable.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./js-yaml.d.ts" />
/**
 * Slice 13-TL — TLP §6.1 intermediate YAML, emit + read-back.
 *
 * PR-TLP-08: the YAML committed under scripts/template-load/yaml/ is the
 * reviewable, diffable artefact between spreadsheet and database. PR-TLP-09:
 * staging and production load from the IDENTICAL YAML — the loader reads
 * these files, never the .xlsx directly. PR-TLP-10: `source_sha256` pins
 * the exact source workbook the YAML was derived from.
 *
 * Key names follow the TLP §6.1 example (snake_case); `parseYaml` restores
 * the exact in-memory `ParsedDocument` (deep-equal round-trip is enforced
 * by I-TL-17).
 */
import { dump, load } from 'js-yaml';
import type {
  Ambiguity,
  ParsedDocument,
  ParsedItem,
  ParsedMeasurement,
  RevisionHistoryEntry,
} from './model';

const HEADER =
  '# Intermediate template-load YAML (BAMFORM-TLP-001 §6.1, PR-TLP-08/09/10).\n' +
  '# GENERATED from the source workbook named below — do not edit by hand;\n' +
  '# regenerate with: npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-extract.ts\n';

/** Drop keys whose value is `undefined` so optional fields round-trip cleanly. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function yamlFileName(doc: ParsedDocument): string {
  return `${doc.documentNumber.replace(/\s+/g, '-')}.yaml`;
}

export function emitYaml(doc: ParsedDocument): string {
  const shape = {
    document_number: doc.documentNumber,
    title: doc.title,
    asset_type_code: doc.assetTypeCode,
    asset_type_name: doc.assetTypeName,
    printed_revision: doc.printedRevision,
    // TLP §6.1 "current_revision" = the revision the load makes CURRENT.
    // B-04 WITHDRAWN 2026-08-03: doc 4 used to load as a synthetic client
    // revision D here; the owner ruled the signed records authoritative
    // (every signed ASM Wire Bond specimen, and cell J66 of the workbook
    // itself, prints "95 - 28 g"), so doc 4 now loads at its printed
    // revision C like every other document.
    current_revision: doc.loadRevision,
    source_file: doc.sourceFile,
    source_sha256: doc.sourceSha256,
    sheet_name: doc.sheetName,
    frequency_banner: doc.frequencyBanner,
    machine_columns: doc.machineColumns,
    revision_history: doc.revisionHistory.map((r) => ({
      code: r.code,
      date: r.date,
      details: r.details,
      revised_by: r.revisedBy,
      approved_by: r.approvedBy,
    })),
    standing_content: {
      special_tools: doc.standingContent.specialTools,
      parts_required: doc.standingContent.partsRequired,
      ppe: doc.standingContent.ppe,
      safety: doc.standingContent.safety,
      procedure: doc.standingContent.procedure,
      remarks: doc.standingContent.remarks,
    },
    standing_content_sources: doc.standingContentSources,
    items: doc.items.map((i) =>
      compact({
        item_no: i.itemNo,
        printed_no: i.printedNo,
        frequency: i.frequency,
        instruction: i.instruction,
        stable_key: i.stableKey,
        display_order: i.displayOrder,
        source_row: i.sourceRow,
      }),
    ),
    measurements: doc.measurements.map((m) =>
      compact({
        section: m.section,
        description: m.description,
        unit: m.unit,
        spec_type: m.specType,
        lower_limit: m.lowerLimit,
        upper_limit: m.upperLimit,
        nominal: m.nominal,
        tolerance: m.tolerance,
        spec_display: m.specDisplay,
        source_spec_display: m.sourceSpecDisplay,
        synthesized_display: m.synthesizedDisplay,
        correction: m.correction,
        unparsed_reason: m.unparsedReason,
        stable_key: m.stableKey,
        display_order: m.displayOrder,
        source_row: m.sourceRow,
        source_cells: m.sourceCells,
      }),
    ),
    notes: doc.notes,
    ambiguities: doc.ambiguities.map((a) => ({
      code: a.code,
      message: a.message,
      cells: a.cells,
    })),
  };
  return HEADER + dump(shape, { lineWidth: 100, noRefs: true });
}

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error(`expected string, got ${JSON.stringify(v)}`);
  return v;
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}
function num(v: unknown): number {
  if (typeof v !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`);
  return v;
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

export function parseYaml(text: string): ParsedDocument {
  const raw = load(text) as Raw;
  const sc = raw.standing_content as Raw;
  const items = (raw.items as Raw[]).map(
    (i): ParsedItem =>
      ({
        itemNo: num(i.item_no),
        printedNo: strOrNull(i.printed_no),
        frequency: str(i.frequency) as ParsedItem['frequency'],
        instruction: str(i.instruction),
        stableKey: str(i.stable_key),
        displayOrder: num(i.display_order),
        sourceRow: num(i.source_row),
      }) satisfies ParsedItem,
  );
  const measurements = (raw.measurements as Raw[]).map((m): ParsedMeasurement => {
    const out: ParsedMeasurement = {
      section: strOrNull(m.section),
      description: str(m.description),
      unit: strOrNull(m.unit),
      specType: str(m.spec_type) as ParsedMeasurement['specType'],
      lowerLimit: numOrNull(m.lower_limit),
      upperLimit: numOrNull(m.upper_limit),
      nominal: numOrNull(m.nominal),
      tolerance: numOrNull(m.tolerance),
      specDisplay: str(m.spec_display),
      stableKey: str(m.stable_key),
      displayOrder: num(m.display_order),
      sourceRow: num(m.source_row),
      sourceCells: (m.source_cells as string[]) ?? [],
    };
    if (m.source_spec_display !== undefined) out.sourceSpecDisplay = str(m.source_spec_display);
    if (m.synthesized_display !== undefined)
      out.synthesizedDisplay = Boolean(m.synthesized_display);
    if (m.correction !== undefined) out.correction = str(m.correction);
    if (m.unparsed_reason !== undefined) out.unparsedReason = str(m.unparsed_reason);
    return out;
  });

  return {
    documentNumber: str(raw.document_number),
    title: str(raw.title),
    assetTypeCode: str(raw.asset_type_code),
    assetTypeName: str(raw.asset_type_name),
    printedRevision: str(raw.printed_revision),
    loadRevision: str(raw.current_revision),
    sourceFile: str(raw.source_file),
    sourceSha256: str(raw.source_sha256),
    sheetName: str(raw.sheet_name),
    frequencyBanner: strOrNull(raw.frequency_banner),
    machineColumns: (raw.machine_columns as string[]) ?? [],
    revisionHistory: (raw.revision_history as Raw[]).map((r): RevisionHistoryEntry => ({
      code: str(r.code),
      date: str(r.date),
      details: str(r.details),
      revisedBy: str(r.revised_by),
      approvedBy: str(r.approved_by),
    })),
    standingContent: {
      specialTools: strOrNull(sc.special_tools),
      partsRequired:
        (sc.parts_required as ParsedDocument['standingContent']['partsRequired']) ?? [],
      ppe: (sc.ppe as string[]) ?? [],
      safety: strOrNull(sc.safety),
      procedure: strOrNull(sc.procedure),
      remarks: strOrNull(sc.remarks),
    },
    standingContentSources: (raw.standing_content_sources as Record<string, string>) ?? {},
    items,
    measurements,
    notes: (raw.notes as string[]) ?? [],
    ambiguities: (raw.ambiguities as Raw[]).map((a): Ambiguity => ({
      code: str(a.code) as Ambiguity['code'],
      message: str(a.message),
      cells: (a.cells as string[]) ?? [],
    })),
  };
}
