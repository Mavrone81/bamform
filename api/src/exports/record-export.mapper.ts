import type { RecordExport, RecordExportStatusT } from '@prisma/client';
import type { RecordExportStatusResponse } from '@bamform/shared';

export const RECORD_EXPORT_STATUS_FROM_DB: Record<
  RecordExportStatusT,
  RecordExportStatusResponse['status']
> = {
  pending: 'PENDING',
  processing: 'PROCESSING',
  done: 'DONE',
  failed: 'FAILED',
};

/** ADR-007 — `downloadPath` is only populated once `status === 'DONE'`; the artifact is always streamed through `api`, never a presigned URL. */
export function toRecordExportStatusResponse(row: RecordExport): RecordExportStatusResponse {
  const status = RECORD_EXPORT_STATUS_FROM_DB[row.status];
  return {
    id: row.id,
    status,
    recordCount: row.recordCount,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    failedReason: row.failedReason,
    downloadPath: status === 'DONE' ? `/exports/${row.id}/download` : null,
  };
}
