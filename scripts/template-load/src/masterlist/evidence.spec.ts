// scripts/template-load/src/masterlist/evidence.spec.ts
/**
 * Slice masterlist-migration — Task 6 review fix round 1, IMPORTANT-3.
 *
 * `renderImportEvidence` is pure (no filesystem/network access) and 161+
 * lines — exactly the kind of function CI should be pinning. Asserts every
 * mandated section renders (source label/code/asset type/document for the
 * imported table, plus left-unplanned, skipped and unmapped/hard-error
 * sections) and that a machine's frequencies render WITH their work week
 * (review fix round 1, IMPORTANT-4).
 *
 * Owner ruling 2026-08-03: the migration no longer computes or sends a
 * `machineNumber` (the blank in a form's title is filled in by hand by the
 * technician, not by this migration — see `import.ts`'s file header). There
 * is therefore no `Machine #` column and no `machineNumber` field on
 * `MachineImportResult` any more; the tests below assert the column is
 * gone and that the explanatory note is present exactly once.
 */
import type { ImportReport, ImportTemplateRef, MachineImportResult } from './import';
import { renderImportEvidence } from './evidence';

const templates: Record<string, ImportTemplateRef> = {
  BESI_DIE_ATTACH: { documentNumber: 'CE 95 010 00 01' },
  ASM_WIRE_BOND: { documentNumber: 'CE 95 020 00 01' },
  MB_E_TEST: { documentNumber: 'CE 95 050 00 01' },
};

const base: Omit<MachineImportResult, 'label' | 'code' | 'assetTypeCode' | 'status'> = {
  blocked: false,
  documentAttached: false,
  leftUnplanned: false,
  dueDates: {},
  dueWeeks: {},
  surplus: [],
};

const imported: MachineImportResult = {
  ...base,
  label: 'ESEC 2008 sc3 plus -- ED01',
  code: 'ED01',
  assetTypeCode: 'BESI_DIE_ATTACH',
  status: 'imported',
  documentAttached: true,
  dueDates: { M6: '2026-01-29', M3: '2026-04-30', Y: '2026-07-23' },
  dueWeeks: { M6: 5, M3: 18, Y: 30 },
};

const contestable: MachineImportResult = {
  ...base,
  label: 'MS-620 ST01',
  code: 'ST01',
  assetTypeCode: 'MB_E_TEST',
  status: 'imported',
  documentAttached: true,
  dueDates: { M1: '2026-01-08' },
  dueWeeks: { M1: 2 },
};

const leftUnplanned: MachineImportResult = {
  ...base,
  label: 'ASM Eagle Xtreme GoCu -- AW06',
  code: 'AW06',
  assetTypeCode: 'ASM_WIRE_BOND',
  status: 'imported',
  documentAttached: false,
  leftUnplanned: true,
  surplus: ['Y'],
  message:
    'machine created only, no document attached (surplus: Y); a planner must attach ' +
    'CE 95 020 00 01 and set the dates',
};

const skipped: MachineImportResult = {
  ...base,
  label: 'DDA 03',
  code: '03',
  assetTypeCode: null,
  status: 'skipped',
};

const blocked: MachineImportResult = {
  ...base,
  label: 'Some Unmapped Machine -- ZZ99',
  code: 'ZZ99',
  assetTypeCode: null,
  status: 'unmapped',
  blocked: true,
  message: 'unmapped model and no existing asset',
};

const report: ImportReport = {
  dryRun: true,
  machines: [imported, contestable, leftUnplanned, skipped, blocked],
  counts: { skipped: 1, unmapped: 1, hardError: 0, imported: 3, blocked: 1, leftUnplanned: 1 },
};

describe('renderImportEvidence', () => {
  const out = renderImportEvidence(report, {
    templates,
    file: 'scripts/template-load/src/masterlist/__fixtures__/masterlist.xlsx',
    year: 2026,
  });

  it('renders every mandated section', () => {
    expect(out).toContain('## Machines imported with a schedule');
    expect(out).toContain('## Left unplanned for a planner');
    expect(out).toContain('## Skipped');
    expect(out).toContain('## Unmapped / hard-error');
  });

  it("shows an imported machine's source label, code, asset type and document", () => {
    expect(out).toContain('ESEC 2008 sc3 plus -- ED01');
    expect(out).toContain('| ED01 |');
    expect(out).toContain('BESI_DIE_ATTACH');
    expect(out).toContain('CE 95 010 00 01');
  });

  it("shows a machine's frequencies WITH the masterlist's own work week, not just the ISO date", () => {
    expect(out).toContain('M6: 2026-01-29 (WW5)');
    expect(out).toContain('M3: 2026-04-30 (WW18)');
    expect(out).toContain('Y: 2026-07-23 (WW30)');
  });

  it('does not render a Machine # column in any table header (owner ruling 2026-08-03: technician-filled, not migration-set)', () => {
    const headerRows = out.split('\n').filter((l) => l.startsWith('| Source label'));
    expect(headerRows.length).toBeGreaterThan(0);
    for (const header of headerRows) {
      expect(header).not.toContain('Machine #');
    }
    expect(out).not.toContain('machineNumber');
  });

  it('states plainly, exactly once, that the blank is filled in by hand by the technician', () => {
    const needle = 'filled in by hand by the technician when they complete';
    const occurrences = out.split(needle).length - 1;
    expect(occurrences).toBe(1);
    expect(out).toContain(
      "The blank in a form's title is filled in by hand by the technician when they complete " +
        'the record, so this migration deliberately leaves it unset',
    );
    // Honest about the consequence: nothing fills it today, not even the app.
    expect(out).toMatch(/no field on the.*record-capture screen sets it/);
  });

  it("the imported table's header row has no Machine # column", () => {
    const headerRow = out
      .split('\n')
      .find((l) => l.startsWith('| Source label (masterlist column A)'));
    expect(headerRow).toBeDefined();
    expect(headerRow).not.toContain('Machine #');
    expect(headerRow).toBe(
      '| Source label (masterlist column A) | Code | Asset type | Document | Frequencies (first due date, work week) |',
    );
  });

  it('lists the left-unplanned machine with its surplus frequency and reason', () => {
    expect(out).toContain('AW06');
    expect(out).toMatch(/\| AW06 \|.*\| Y \|/);
  });

  it('tells the owner the document is NOT attached for a left-unplanned machine, and what a planner must do', () => {
    const section = out.slice(
      out.indexOf('## Left unplanned for a planner'),
      out.indexOf('## Skipped'),
    );
    expect(section).toMatch(/NOT attached/);
    expect(section).toContain('A planner must');
    expect(section).toContain('attach the document');
    // AW06's row still names its would-be document so a planner knows what to attach.
    expect(section).toContain('CE 95 020 00 01');
  });

  it("the left-unplanned table's header row has no Machine # column", () => {
    const section = out.slice(
      out.indexOf('## Left unplanned for a planner'),
      out.indexOf('## Skipped'),
    );
    const header = section.split('\n').find((l) => l.startsWith('| Source label'));
    expect(header).toBeDefined();
    expect(header).not.toContain('Machine #');
    expect(header).toBe(
      '| Source label | Code | Asset type | Document to attach | Surplus frequency (form defines it, plan does not schedule it) |',
    );
  });

  it('lists the skipped and blocked rows with their reasons', () => {
    expect(out).toContain('DDA 03');
    expect(out).toContain('ZZ99');
    expect(out).toContain('unmapped model and no existing asset');
  });

  it('footnotes a contestable mapping and explains it', () => {
    expect(out).toContain('MS-620 ST01 [†](#contestable-mappings)');
    expect(out).toContain('## Contestable mappings');
    expect(out).toContain('owner decision 1');
  });

  it('does not hardcode a source document number/revision in the title', () => {
    expect(out.split('\n')[0]).toBe('# Masterlist Import Evidence');
  });

  it('renders the source workbook path as given, without an absolute-path assumption', () => {
    expect(out).toContain('scripts/template-load/src/masterlist/__fixtures__/masterlist.xlsx');
  });
});
