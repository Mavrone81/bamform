// scripts/template-load/src/masterlist/evidence.spec.ts
/**
 * Slice masterlist-migration — Task 6 review fix round 1, IMPORTANT-3.
 *
 * `renderImportEvidence` is pure (no filesystem/network access) and 161+
 * lines — exactly the kind of function CI should be pinning. Asserts every
 * mandated section renders (source label/code/asset type/document/machine
 * number/frequencies for the imported table, plus left-unplanned, skipped
 * and unmapped/hard-error sections) and that a machine's frequencies render
 * WITH their work week (review fix round 1, IMPORTANT-4).
 */
import type { ImportReport, ImportTemplateRef, MachineImportResult } from './import';
import { renderImportEvidence } from './evidence';

const templates: Record<string, ImportTemplateRef> = {
  BESI_DIE_ATTACH: {
    documentNumber: 'CE 95 010 00 01',
    title: 'ESEC Preventive Maintenance Record ED___',
  },
  ASM_WIRE_BOND: {
    documentNumber: 'CE 95 020 00 01',
    title: 'ASM Preventive Maintenance Record AW___',
  },
  MB_E_TEST: {
    documentNumber: 'CE 95 050 00 01',
    title: 'MB E-Test Preventive Maintenance Record______',
  },
};

const base: Omit<MachineImportResult, 'label' | 'code' | 'assetTypeCode' | 'status'> = {
  blocked: false,
  documentAttached: false,
  leftUnplanned: false,
  dueDates: {},
  dueWeeks: {},
  machineNumber: null,
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
  machineNumber: '01',
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
  machineNumber: 'ST01',
};

const leftUnplanned: MachineImportResult = {
  ...base,
  label: 'ASM Eagle Xtreme GoCu -- AW06',
  code: 'AW06',
  assetTypeCode: 'ASM_WIRE_BOND',
  status: 'imported',
  documentAttached: true,
  leftUnplanned: true,
  surplus: ['Y'],
  message: 'left unplanned for a planner (surplus: Y)',
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

  it('shows the machine number column', () => {
    // ED01's row: "... | CE 95 010 00 01 | 01 | M3: ..."
    expect(out).toMatch(/CE 95 010 00 01 \| 01 \|/);
  });

  it('lists the left-unplanned machine with its surplus frequency and reason', () => {
    expect(out).toContain('AW06');
    expect(out).toMatch(/\| AW06 \|.*\| Y \|/);
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
