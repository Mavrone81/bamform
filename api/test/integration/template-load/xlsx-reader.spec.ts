/**
 * Slice 13-TL — hand-rolled .xlsx cell-text reader (TEST_PLAN I-TL-01..04).
 *
 * BAMFORM-TLP-001 (docs/TEMPLATE_LOAD_PLAN.md) §6 requires extraction of the
 * twelve source workbooks to reviewable YAML. Per the slice brief's
 * zero-new-dependency policy the reader is hand-rolled (ZIP central
 * directory + zlib.inflateRawSync + sharedStrings + sheet XML — Node core
 * only), and per the same policy it is validated here against a MANUALLY
 * TRANSCRIBED fixture for the TLP §5.1 reference case (doc 4, ASM Wire
 * Bond): scripts/template-load/fixtures/doc4-manual-transcription.json.
 * The fixture was transcribed by hand from the raw sheet XML independently
 * of the reader under test, the same standard the project used for the QR
 * encoder (verified against a reference implementation).
 *
 * These tests run against the REAL plant documents in `Sample of Forms/`,
 * not idealised fixtures (PR-TST-18's real-template-content exception).
 * No database required.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkbook } from '../../../../scripts/template-load/src/xlsx';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FORMS_DIR = join(REPO_ROOT, 'Sample of Forms');

const ALL_TWELVE = [
  'CE 95 010 00 01 Besi Die Attach Preventive Maintenance Record.xlsx',
  'CE 95 012 00 01 Emerald Pick and Place Preventive Maintenance Record EP01.xlsx',
  'CE 95 012 00 02 Powatec Mounting Preventive Maintenance Record PM01.xlsx',
  'CE 95 020 00 01 ASM Wire Bond Preventive Maintenance Record.xlsx',
  'CE 95 020 00 02 Besi Wire Bond Preventive Maintenance Record.xlsx',
  'CE 95 020 00 03 KNS Wire Bond Preventive Maintenance Record.xlsx',
  'CE 95 030 00 01 MB Encapsulation Preventive Maintenance Record .xlsx',
  'CE 95 030 00 03 Pre-mixer machine Preventive Maintenance Record DP_____.xlsx',
  'CE 95 043 00 01 Bump Dispensing Preventive Maintenance WI and Record.xlsx',
  'CE 95 050 00 01 MB E-test Preventive Maintenance Record .xlsx',
  'CE 95 050 00 03 OS Loading Preventive Maintenance Record IMOS.xlsx',
  'CE 95 055 00 01 Preventive Maintenance Work Instruction Record AVS.xlsx',
];

describe('template-load xlsx reader (I-TL-01..04)', () => {
  it('I-TL-01: reads every one of the 12 real workbooks without error, each with 2 sheets', () => {
    for (const file of ALL_TWELVE) {
      const wb = readWorkbook(join(FORMS_DIR, file));
      expect(wb.sheets).toHaveLength(2);
      // Every form has a content sheet and a "Revision History" sheet.
      expect(wb.sheets[1].name).toBe('Revision History');
    }
  });

  it('I-TL-02: reproduces the manually transcribed reference fixture for doc 4 EXACTLY (every transcribed cell, verbatim, including leading/trailing spaces and the B-04 defect)', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'scripts', 'template-load', 'fixtures', 'doc4-manual-transcription.json'),
        'utf8',
      ),
    ) as {
      file: string;
      sheetNames: string[];
      sheet1: Record<string, string>;
      sheet2: Record<string, string>;
    };

    const wb = readWorkbook(join(FORMS_DIR, fixture.file));
    expect(wb.sheets.map((s) => s.name)).toEqual(fixture.sheetNames);

    for (const [sheetIdx, expected] of [fixture.sheet1, fixture.sheet2].entries()) {
      const cells = wb.sheets[sheetIdx].cells;
      for (const [ref, value] of Object.entries(expected)) {
        // Exact, verbatim — a whitespace difference here is a parse defect.
        expect({ sheet: sheetIdx + 1, ref, value: cells[ref] }).toEqual({
          sheet: sheetIdx + 1,
          ref,
          value,
        });
      }
    }
  });

  it('I-TL-02b: the fixture comparison is not vacuous — doc 4 sheet 1 contains no transcription-missed non-empty cells outside the fixture (full-coverage check)', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'scripts', 'template-load', 'fixtures', 'doc4-manual-transcription.json'),
        'utf8',
      ),
    ) as { file: string; sheet1: Record<string, string>; sheet2: Record<string, string> };
    const wb = readWorkbook(join(FORMS_DIR, fixture.file));
    for (const [sheetIdx, expected] of [fixture.sheet1, fixture.sheet2].entries()) {
      const extras = Object.entries(wb.sheets[sheetIdx].cells)
        .filter(([, v]) => v !== undefined && v !== '')
        .filter(([ref]) => !(ref in expected))
        .map(([ref, v]) => `${ref}=${JSON.stringify(v)}`);
      expect({ sheet: sheetIdx + 1, extras }).toEqual({ sheet: sheetIdx + 1, extras: [] });
    }
  });

  it('I-TL-03: decodes XML entities, multi-run rich text and CRLF in shared strings (doc 9 curly apostrophe; doc 4 revision details)', () => {
    const doc9 = readWorkbook(
      join(FORMS_DIR, 'CE 95 043 00 01 Bump Dispensing Preventive Maintenance WI and Record.xlsx'),
    );
    expect(doc9.sheets[0].cells['C32']).toBe(
      'Check if the optical sensors to control dancing rollers’ position work well',
    );
    const doc4 = readWorkbook(
      join(FORMS_DIR, 'CE 95 020 00 01 ASM Wire Bond Preventive Maintenance Record.xlsx'),
    );
    expect(doc4.sheets[1].cells['C5']).toBe(
      '1. Retitle to add ASM\r\n2. Updated PM frequency\r\n3. Updated to include calibration reading recording',
    );
  });

  it('I-TL-04: surfaces formula error cells distinctly (doc 1 #REF!, doc 9 #VALUE! — defect B-01), never as ordinary text', () => {
    const doc1 = readWorkbook(
      join(FORMS_DIR, 'CE 95 010 00 01 Besi Die Attach Preventive Maintenance Record.xlsx'),
    );
    // Revision History header cells are #REF! errors in the source (B-01).
    expect(doc1.sheets[1].cells['A1']).toBe('#ERROR:#REF!');
    expect(doc1.sheets[1].cells['B1']).toBe('#ERROR:#REF!');
    const doc9 = readWorkbook(
      join(FORMS_DIR, 'CE 95 043 00 01 Bump Dispensing Preventive Maintenance WI and Record.xlsx'),
    );
    expect(doc9.sheets[1].cells['D1']).toBe('#ERROR:#VALUE!');
  });
});
