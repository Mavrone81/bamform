/**
 * Minimal .xlsx cell-text reader — slice 13-TL (BAMFORM-TLP-001).
 *
 * Purpose-built to extract CELL TEXT from the twelve known PM workbooks in
 * `Sample of Forms/`; deliberately NOT a general spreadsheet engine. Uses
 * Node core only (fs + zlib) per the slice's zero-new-dependency policy;
 * verified against a manually transcribed reference fixture in
 * api/test/integration/template-load/xlsx-reader.spec.ts (I-TL-01..04),
 * the same hand-roll-then-verify standard the project applied to the QR
 * encoder.
 *
 * Supported surface (all that the 12 sources need):
 *  - ZIP: end-of-central-directory scan, central directory walk, local
 *    header offset resolution, STORED (0) and DEFLATE (8) entries.
 *  - xl/workbook.xml sheet names + r:id → xl/_rels/workbook.xml.rels targets.
 *  - xl/sharedStrings.xml: <si> with one or many <t> runs, XML entities,
 *    `_xHHHH_` escapes.
 *  - Sheet XML: <row>/<c r= t=>: shared strings (t="s"), inline strings
 *    (t="inlineStr"), formula strings (t="str"), booleans (t="b"), numbers
 *    (default), and error cells (t="e") surfaced distinctly as
 *    `#ERROR:<code>` so a defective source cell (defect B-01) can never be
 *    mistaken for ordinary text.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export interface Sheet {
  name: string;
  /** Cell reference (e.g. "C2") → verbatim text. Absent = empty cell. */
  cells: Record<string, string>;
}

export interface Workbook {
  /** In workbook order. */
  sheets: Sheet[];
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // End of central directory: scan backwards (allow for a trailing comment).
  let eocd = -1;
  const minEocd = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a ZIP file: end-of-central-directory signature not found');
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CDIR_SIG) {
      throw new Error(`Corrupt ZIP: central directory entry ${i} has a bad signature`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // The local header's name/extra lengths can differ from the central
    // directory's — resolve the data start from the local header itself.
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt ZIP: local header for ${name} has a bad signature`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    entries.set(name, data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// XML text helpers (regex-scoped to the fixed OOXML shapes listed above)
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    }
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return whole; // unknown named entity — leave verbatim, never guess
    }
  });
}

/** OOXML `_xHHHH_` escapes (e.g. `_x000D_` = CR) used inside <t> runs. */
function decodeOoxmlEscapes(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}

/** Concatenate every <t> run inside an <si> or <is> body, verbatim. */
function textRuns(body: string): string {
  let out = '';
  const runRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(body)) !== null) {
    out += decodeOoxmlEscapes(decodeEntities(m[1] ?? ''));
  }
  return out;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    strings.push(textRuns(m[1]));
  }
  return strings;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function parseSheetCells(xml: string, shared: string[]): Record<string, string> {
  const cells: Record<string, string> = {};
  // <c r="A1" ... t="s"><v>3</v></c> | <c r="B2"/> | <c r="C3" t="inlineStr"><is><t>x</t></is></c>
  const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2] ?? '';
    const refMatch = /(?:^|\s)r="([A-Z]+[0-9]+)"/.exec(attrs);
    if (!refMatch) continue;
    const ref = refMatch[1];
    const typeMatch = /(?:^|\s)t="([^"]+)"/.exec(attrs);
    const type = typeMatch ? typeMatch[1] : 'n';

    let value: string | undefined;
    if (type === 'inlineStr') {
      const is = /<is>([\s\S]*?)<\/is>/.exec(body);
      value = is ? textRuns(is[1]) : undefined;
    } else {
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
      if (v) {
        const rawValue = decodeOoxmlEscapes(decodeEntities(v[1]));
        if (type === 's') {
          const idx = Number.parseInt(rawValue, 10);
          const resolved = shared[idx];
          if (resolved === undefined) {
            throw new Error(`Shared string index ${rawValue} out of range at ${ref}`);
          }
          value = resolved;
        } else if (type === 'e') {
          // Defect B-01: formula error cells are surfaced distinctly so the
          // parser can never mistake `#REF!` for a document number.
          value = `#ERROR:${rawValue}`;
        } else {
          // n (number), str (formula string), b (boolean) — verbatim text.
          value = rawValue;
        }
      }
    }
    if (value !== undefined) {
      cells[ref] = value;
    }
  }
  return cells;
}

interface SheetRef {
  name: string;
  rId: string;
}

function parseWorkbookSheets(workbookXml: string): SheetRef[] {
  const out: SheetRef[] = [];
  const re = /<sheet\s([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(workbookXml)) !== null) {
    const attrs = m[1];
    const name = /(?:^|\s)name="([^"]*)"/.exec(attrs);
    const rId = /(?:^|\s)r:id="([^"]*)"/.exec(attrs);
    if (name && rId) {
      out.push({ name: decodeEntities(name[1]), rId: rId[1] });
    }
  }
  return out;
}

function parseWorkbookRels(relsXml: string): Map<string, string> {
  const rels = new Map<string, string>();
  const re = /<Relationship\s([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml)) !== null) {
    const attrs = m[1];
    const id = /(?:^|\s)Id="([^"]*)"/.exec(attrs);
    const target = /(?:^|\s)Target="([^"]*)"/.exec(attrs);
    if (id && target) {
      rels.set(id[1], target[1].replace(/^\//, ''));
    }
  }
  return rels;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readWorkbook(path: string): Workbook {
  const entries = readZipEntries(readFileSync(path));
  const text = (name: string): string | undefined => entries.get(name)?.toString('utf8');

  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) {
    throw new Error(`${path}: xl/workbook.xml missing — not an .xlsx workbook`);
  }
  const relsXml = text('xl/_rels/workbook.xml.rels');
  if (!relsXml) {
    throw new Error(`${path}: xl/_rels/workbook.xml.rels missing`);
  }
  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));
  const rels = parseWorkbookRels(relsXml);

  const sheets = parseWorkbookSheets(workbookXml).map((sheetRef) => {
    const target = rels.get(sheetRef.rId);
    if (!target) {
      throw new Error(`${path}: sheet "${sheetRef.name}" has no relationship ${sheetRef.rId}`);
    }
    const sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
    const sheetXml = text(sheetPath);
    if (!sheetXml) {
      throw new Error(`${path}: sheet part ${sheetPath} missing`);
    }
    return { name: sheetRef.name, cells: parseSheetCells(sheetXml, shared) };
  });

  return { sheets };
}

/** Excel 1900-date-system serial → ISO date (all 12 sources use the 1900 system). */
export function excelSerialToIsoDate(serial: number): string {
  // Excel day 1 = 1900-01-01; the base below already absorbs Excel's
  // fictitious 1900-02-29 (day 60), which no source date predates.
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
