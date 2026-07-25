import { buildExportManifestCsv, pdfEntryFilename, type ExportManifestRow } from './export-csv';

function row(overrides: Partial<ExportManifestRow> = {}): ExportManifestRow {
  return {
    recordId: 'rec-1',
    jobNumber: 'PM-0001',
    assetCode: 'AST-1',
    documentNumber: 'DOC-1',
    revisionCode: 'R1',
    frequency: 'M1',
    archivedAt: '2026-07-01T00:00:00.000Z',
    pdfFilename: 'records/PM-0001.pdf',
    ...overrides,
  };
}

describe('buildExportManifestCsv (PR-119)', () => {
  it('emits a header row with the expected columns', () => {
    const csv = buildExportManifestCsv([]);
    expect(csv.split('\r\n')[0]).toBe(
      'recordId,jobNumber,assetCode,documentNumber,revisionCode,frequency,archivedAt,pdfFilename',
    );
  });

  it('emits one data row per record, in the given order', () => {
    const csv = buildExportManifestCsv([row({ recordId: 'a' }), row({ recordId: 'b' })]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2
    expect(lines[1]).toContain('a');
    expect(lines[2]).toContain('b');
  });

  it('quotes a field containing a comma', () => {
    const csv = buildExportManifestCsv([row({ assetCode: 'AST,1' })]);
    expect(csv).toContain('"AST,1"');
  });

  it('escapes an embedded quote by doubling it', () => {
    const csv = buildExportManifestCsv([row({ assetCode: 'AST"1' })]);
    expect(csv).toContain('"AST""1"');
  });

  it('renders a null archivedAt as an empty field, not the string "null"', () => {
    const csv = buildExportManifestCsv([row({ archivedAt: null })]);
    expect(csv).not.toContain('null');
  });
});

describe('pdfEntryFilename', () => {
  it('builds a records/{jobNumber}.pdf path', () => {
    expect(pdfEntryFilename('PM-0001')).toBe('records/PM-0001.pdf');
  });

  it('sanitises path-traversal characters out of the job number', () => {
    expect(pdfEntryFilename('../../etc/passwd')).toBe('records/.._.._etc_passwd.pdf');
    expect(pdfEntryFilename('/absolute/path')).toBe('records/_absolute_path.pdf');
  });
});
