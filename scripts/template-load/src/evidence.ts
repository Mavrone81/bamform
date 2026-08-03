/**
 * Slice 13-TL — AC-01 evidence pack generator (BAMFORM-TLP-001 §7).
 *
 * One markdown file per source document showing SOURCE CELL → PARSED FIELD
 * for every item and measurement, plus the standing content, revision
 * history and the ambiguity register for that document — reviewable by the
 * client's Quality function against the paper original, per-document
 * checklist V-1..V-14. `renderRegister` aggregates the cross-document
 * checks (X-1..X-6) and every open decision.
 *
 * Raw source text is rendered with JSON escaping (quotes, \r\n, interior
 * spacing all visible) so a reviewer can see EXACTLY what the cell holds —
 * markdown-invisible whitespace differences are the whole point of showing
 * it this way.
 */
import { join } from 'node:path';
import type { ParsedDocument } from './model';
import { readWorkbook } from './xlsx';

export function evidenceFileName(doc: ParsedDocument): string {
  return `${doc.documentNumber.replace(/\s+/g, '-')}.md`;
}

const esc = (s: string): string => JSON.stringify(s).replace(/\|/g, '\\|');
const cellOrEmpty = (cells: Record<string, string>, ref: string): string =>
  ref in cells ? esc(cells[ref]) : '·';
const show = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? '·' : typeof v === 'number' ? String(v) : esc(v);

export function renderEvidence(doc: ParsedDocument, formsDir: string): string {
  const workbook = readWorkbook(join(formsDir, doc.sourceFile));
  const s1 = workbook.sheets[0].cells;
  const s2 = workbook.sheets.find((s) => s.name === 'Revision History')!.cells;

  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(
    `# AC-01 Evidence — ${doc.documentNumber}`,
    '',
    `**${doc.title.replace(/\r?\n/g, ' ')}**`,
    '',
    '| | |',
    '|---|---|',
    `| Source file | \`${doc.sourceFile}\` |`,
    `| Source SHA-256 (PR-TLP-10) | \`${doc.sourceSha256}\` |`,
    `| Worksheet name | ${esc(doc.sheetName)} |`,
    `| Printed revision | ${esc(doc.printedRevision)} |`,
    `| Revision loaded as CURRENT | ${esc(doc.loadRevision)}${
      doc.loadRevision !== doc.printedRevision ? ' — see the B-04 disposition below' : ''
    } |`,
    `| Machine column(s) on the checklist | ${doc.machineColumns.map(esc).join(', ')} |`,
    `| Frequency banner (loaded into standing content) | ${show(doc.frequencyBanner)} |`,
    `| Asset type | \`${doc.assetTypeCode}\` (${doc.assetTypeName}) |`,
    '',
    '> **How to read this file** — every source value is shown JSON-escaped so whitespace and',
    '> line breaks are visible exactly as stored. "Loaded" values are what the system stores;',
    "> the system's validation layer trims LEADING/TRAILING whitespace only (interior text is",
    '> verbatim, PR-TLP-04). `·` marks an empty source cell / absent value.',
    '',
  );

  // Title block ----------------------------------------------------------
  push(
    '## Title block (V-1..V-3)',
    '',
    '| Source cell | Source text | Loaded field | Loaded value |',
    '|---|---|---|---|',
  );
  const titleRow = Object.keys(s1).find((ref) => s1[ref] === 'Document Title:');
  const headerRowNum = titleRow ? Number(/\d+/.exec(titleRow)![0]) + 1 : 2;
  push(
    `| C${headerRowNum} | ${cellOrEmpty(s1, `C${headerRowNum}`)} | \`form_template.title\` | ${esc(doc.title)} |`,
    `| K${headerRowNum} | ${cellOrEmpty(s1, `K${headerRowNum}`)} | \`form_template.document_number\` | ${esc(doc.documentNumber)} |`,
    `| M${headerRowNum} | ${cellOrEmpty(s1, `M${headerRowNum}`)} | printed revision | ${esc(doc.printedRevision)} |`,
    '',
  );

  // Standing content -----------------------------------------------------
  push(
    '## Standing content (V-6..V-9)',
    '',
    '| Field | Source cell(s) | Loaded value |',
    '|---|---|---|',
  );
  const sc = doc.standingContent;
  const src = doc.standingContentSources;
  push(
    `| \`special_tools\` | ${src.specialTools ?? '·'} | ${show(sc.specialTools)} |`,
    `| \`parts_required\` | ${src.partsRequired ?? '·'} | ${
      sc.partsRequired.length === 0
        ? '(empty rows dropped — table structure preserved, TLP §4.1)'
        : esc(JSON.stringify(sc.partsRequired))
    } |`,
    ...sc.ppe.map((p, i) => `| \`ppe[${i}]\` | ${src.ppe ?? '·'} | ${esc(p)} |`),
    `| \`safety\` | ${src.safety ?? '·'} | ${show(sc.safety)} |`,
    `| \`procedure\` | ${src.procedure ?? '·'} | ${show(sc.procedure)} |`,
    `| \`remarks\` | ${src.remarks ?? '·'} | ${show(sc.remarks)} |`,
    '',
  );

  // Items ----------------------------------------------------------------
  push(
    `## Checklist items — ${doc.items.length} (V-4, V-5)`,
    '',
    '| Row | No (source) | Freq. (source) | Instruction (source, verbatim) | → item_no | frequency | stable_key |',
    '|---|---|---|---|---|---|---|',
  );
  for (const item of doc.items) {
    const r = item.sourceRow;
    push(
      `| ${r} | ${cellOrEmpty(s1, `A${r}`)} | ${cellOrEmpty(s1, `B${r}`)} | ${cellOrEmpty(
        s1,
        `C${r}`,
      )} | ${item.itemNo} | ${item.frequency} | \`${item.stableKey}\` |`,
    );
  }
  push('');

  // Measurements ---------------------------------------------------------
  if (doc.measurements.length > 0) {
    push(
      `## Measurements — ${doc.measurements.length} (V-10..V-12)`,
      '',
      '| Row | Source cells | Source text | → section | description | spec_type | lower | upper | nominal | tol | unit | spec_display | flags |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const m of doc.measurements) {
      const sourceTexts = m.sourceCells.map((ref) => cellOrEmpty(s1, ref)).join(' / ');
      const flags = [
        m.correction ? `CORRECTED (${m.correction})` : null,
        m.sourceSpecDisplay ? `source read ${esc(m.sourceSpecDisplay)}` : null,
        m.synthesizedDisplay ? 'display synthesised from table columns' : null,
        m.unparsedReason ? `NOT PARSED: ${m.unparsedReason}` : null,
      ]
        .filter((f): f is string => f !== null)
        .join('; ');
      push(
        `| ${m.sourceRow} | ${m.sourceCells.join(', ')} | ${sourceTexts} | ${show(m.section)} | ${esc(
          m.description,
        )} | ${m.specType} | ${show(m.lowerLimit)} | ${show(m.upperLimit)} | ${show(
          m.nominal,
        )} | ${show(m.tolerance)} | ${show(m.unit)} | ${esc(m.specDisplay)} | ${flags || '·'} |`,
      );
    }
    push('');
  } else {
    push('## Measurements — none in this document (V-10 n/a)', '');
  }

  // Revision history ------------------------------------------------------
  push(
    '## Revision history (V-13)',
    '',
    '| Source date (Excel serial) | → date | Revision (verbatim) | Details | Revised by | Approved by |',
    '|---|---|---|---|---|---|',
  );
  const serialByIndex: string[] = [];
  for (const ref of Object.keys(s2)) {
    const m = /^A(\d+)$/.exec(ref);
    if (m && /^\d+$/.test(s2[ref].trim())) serialByIndex.push(s2[ref].trim());
  }
  for (const [i, entry] of doc.revisionHistory.entries()) {
    push(
      `| ${serialByIndex[i] ?? '·'} | ${entry.date} | ${esc(entry.code)} | ${esc(
        entry.details,
      )} | ${esc(entry.revisedBy)} | ${esc(entry.approvedBy)} |`,
    );
  }
  push('');

  // Ambiguities -----------------------------------------------------------
  push('## Defects, ambiguities and dispositions for this document (V-14)', '');
  if (doc.ambiguities.length === 0) {
    push('None recorded.', '');
  } else {
    for (const a of doc.ambiguities) {
      push(`- **${a.code}**${a.cells.length ? ` [${a.cells.join(', ')}]` : ''}: ${a.message}`);
    }
    push('');
  }

  push(
    '## Sign-off (TLP §7.3)',
    '',
    '| Document | Verified by | Signature | Date | Discrepancies |',
    '|---|---|---|---|---|',
    `| ${doc.documentNumber} | | | | |`,
    '',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cross-document register
// ---------------------------------------------------------------------------

export function renderRegister(docs: ParsedDocument[]): string {
  const totalItems = docs.reduce((n, d) => n + d.items.length, 0);
  const totalMeasurements = docs.reduce((n, d) => n + d.measurements.length, 0);
  const textEscalations = docs.flatMap((d) =>
    d.measurements
      .filter((m) => m.specType === 'TEXT' && m.unparsedReason)
      .map((m) => ({ doc: d.documentNumber, m })),
  );
  const codes = new Set(docs.map((d) => d.assetTypeCode));

  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  push(
    '# Template Load — Ambiguity Register and Cross-Document Checks',
    '',
    'Generated with the AC-01 evidence pack (BAMFORM-TLP-001 §7.2). Regenerate with',
    '`npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-extract.ts`.',
    '',
    '## Cross-document checks (X-1..X-6)',
    '',
    '| # | Check | Result |',
    '|---|---|---|',
    `| X-1 | All 12 documents present | ${docs.length === 12 ? 'PASS (12)' : `FAIL (${docs.length})`} |`,
    `| X-2 | Total item count = 145 (TLP §2) | **${
      totalItems === 145 ? 'PASS' : `ATTENTION — source total is ${totalItems}`
    }**${
      totalItems === 146
        ? ' — CE 95 050 00 03 has 11 instruction rows, not the 10 the TLP counted (N-04); the source wins, pending client confirmation'
        : ''
    } |`,
    `| X-3 | Each asset type maps to exactly one template | ${
      codes.size === docs.length ? `PASS (${codes.size} distinct codes)` : 'FAIL (duplicate codes)'
    } |`,
    '| X-4 | Every supplied asset code exists and is correctly typed | PENDING — B-09: the real asset list is a client deliverable; this slice creates clearly-marked provisional SAMPLE machines only (decision 2026-07-27) |',
    '| X-5 | Cascade produces the correct item set for a Y job | Proven per asset type by the loader e2e (api/test/integration/template-load/load-e2e.spec.ts, U-CAS-08) |',
    `| X-6 | No template has an unparsed or inverted specification | ${
      textEscalations.length === 0
        ? 'PASS'
        : `**ATTENTION — ${textEscalations.length} specification(s) escalated as TEXT pending client decisions (no inverted range is ever loaded):**`
    } |`,
    '',
  );
  if (textEscalations.length > 0) {
    for (const { doc, m } of textEscalations) {
      push(`- ${doc} — "${m.description}": \`${m.specDisplay}\` (${m.unparsedReason})`);
    }
    push('');
  }

  push(
    `Total measurements across the set: ${totalMeasurements}.`,
    '',
    '## Outstanding client decisions (TLP §8.2, updated by this load)',
    '',
    '- [x] **B-04** — WITHDRAWN 2026-08-03: the 95 – 105 g correction and its client revision D are reverted. The owner ruled the signed records authoritative, and every signed ASM Wire Bond specimen prints "95 - 28 g", as does the workbook cell itself. Now loaded verbatim as TEXT (the INV-04 mechanism); CE 95 020 00 01 is CURRENT at revision C.',
    '- [ ] B-02 — confirm the wording of the revision-gap note on CE 95 010 00 01.',
    '- [ ] B-03 — confirm the as-printed treatment of out-of-order revision dates (doc CE 95 055 00 01 per the TLP, and the same anomaly found on CE 95 020 00 02, CE 95 030 00 01, CE 95 050 00 01).',
    '- [ ] B-05 — confirm the mapping of short approver names (Sara/Suren) to individuals; history entries are loaded verbatim as free text.',
    '- [ ] **B-09 — supply the real asset list (machine codes per document). Blocking for go-live; sample machines are placeholders.**',
    "- [ ] OI-08 — confirm the cascade rule on CE 95 043 00 01 (its Remarks omit 3M; CE 95 050 00 01 prints the same wording, and CE 95 030 00 01 prints a third variant — see those documents' evidence files).",
    '- [ ] Confirm whether the embedded images in CE 95 043 00 01 / CE 95 055 00 01 are instructionally required (not loaded in Release 1).',
    '- [ ] **N-01** — CE 95 020 00 01 "Track Height Calibration, Top Plate": printed `-295 - -305` (high-to-low, no unit). Loaded as TEXT pending decision.',
    '- [ ] **N-02** — CE 95 020 00 03 "Bond Force  DAC": printed `6.4 - 7,1 counts/gram` (comma decimal). Loaded as TEXT pending decision.',
    '- [ ] N-03 — CE 95 020 00 03 PRS Calibration prints "XY =" twice (evident intent YX). Both loaded verbatim.',
    '- [ ] **N-04** — CE 95 050 00 03 has an unnumbered instruction row; source has 11 rows / set total 146 (TLP counted 10 / 145). Items renumbered positionally; confirm.',
    '- [ ] N-05 — TLP §5.1 states 21 measurements for CE 95 020 00 01; the source sheet has 20.',
    '- [ ] N-06 — CE 95 020 00 02 dual-variant USL/LSL table: confirm the two-measurements-per-row modelling and the inconsistent USL/LSL column labels.',
    '- [ ] N-08 — qualitative/single-value specifications loaded as TEXT (see X-6 list): confirm intended judgements.',
    '- [ ] **N-11** — grouped calibration section labels are space-joined (e.g. CE 95 020 00 01 rows 58-63 → "BH Setup & Calibration Heater Block Setup"). TLP §4.1\'s "blank inherits the section above" would split a genuinely two-section group instead; TLP §5.1 lists those as separate sections. This is the label a technician sees — accept the join, or split per §4.1 (parser change + regeneration). See the per-document evidence tables for every affected group.',
    '',
    '## Per-document ambiguity register',
    '',
  );
  for (const d of docs) {
    push(`### ${d.documentNumber} — ${d.assetTypeName}`, '');
    if (d.ambiguities.length === 0) {
      push('No anomalies recorded.', '');
    } else {
      for (const a of d.ambiguities) {
        push(`- **${a.code}**${a.cells.length ? ` [${a.cells.join(', ')}]` : ''}: ${a.message}`);
      }
      push('');
    }
  }

  return lines.join('\n');
}
