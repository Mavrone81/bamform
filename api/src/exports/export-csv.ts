/**
 * PR-119 — "ZIP of PDFs plus a CSV manifest for filing into the client's
 * existing document management system." Pure function so the manifest
 * shape is unit-testable without a real ZIP/MinIO/BullMQ round trip.
 */
export interface ExportManifestRow {
  recordId: string;
  jobNumber: string;
  assetCode: string;
  documentNumber: string;
  revisionCode: string;
  frequency: string;
  archivedAt: string | null;
  pdfFilename: string;
}

const HEADER = [
  'recordId',
  'jobNumber',
  'assetCode',
  'documentNumber',
  'revisionCode',
  'frequency',
  'archivedAt',
  'pdfFilename',
];

/** RFC 4180 minimal quoting — quote a field iff it contains a comma, quote or newline; escape embedded quotes by doubling. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildExportManifestCsv(rows: readonly ExportManifestRow[]): string {
  const lines = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.recordId,
        row.jobNumber,
        row.assetCode,
        row.documentNumber,
        row.revisionCode,
        row.frequency,
        row.archivedAt ?? '',
        row.pdfFilename,
      ]
        .map(csvField)
        .join(','),
    );
  }
  // CSVs conventionally end with a trailing newline.
  return lines.join('\r\n') + '\r\n';
}

/** `records/{jobNumber}.pdf`, sanitised so a job number can never escape its directory inside the ZIP (path traversal / absolute-path entries). */
export function pdfEntryFilename(jobNumber: string): string {
  const safe = jobNumber.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `records/${safe}.pdf`;
}
