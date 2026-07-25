import type {
  Attachment as AttachmentRow,
  ItemResult as ItemResultRow,
  MeasurementResult as MeasurementResultRow,
  PartUsed as PartUsedRow,
} from '@prisma/client';
import type {
  Attachment,
  AttachmentContentType,
  ItemResult,
  Job,
  JobSummary,
  MeasurementResult,
  PartUsed,
} from '@bamform/shared';
import { toTemplateItem, toTemplateMeasurement, toTemplateRevision } from '../templates/mappers';
import { ITEM_STATUS_FROM_DB, JOB_STATUS_FROM_DB, JUDGEMENT_FROM_DB } from './job-enums';
import type { JobFullRow, JobSummaryRow } from './job-include';
import { isOverdue } from './overdue';

// `*Name` fields (assignedToName/recordedByName/uploadedByName) are omitted
// throughout this mapper — `app_user.full_name` is application-layer
// encrypted (DBD §6.2) and no slice through 5 has wired decryption into a
// list/get read path yet (`templates/mappers.ts#toTemplateRevision` already
// establishes this precedent: `authoredByName`/`approvedByName` are
// documented as optional in openapi.yaml and never populated). This slice
// follows the same, already-accepted convention rather than introducing
// display-decryption plumbing unrelated to PR-030..034/045 — see
// slice-6-report.md.

export function toJobSummary(row: JobSummaryRow, today: Date = new Date()): JobSummary {
  return {
    id: row.id,
    jobNumber: row.jobNumber,
    assetId: row.assetId,
    assetCode: row.asset.code,
    documentNumber: row.templateRevision.formTemplate.documentNumber,
    revisionCode: row.templateRevision.revisionCode,
    frequency: row.frequency,
    frequencyScope: row.frequencyScope,
    dueOn: row.dueOn.toISOString().slice(0, 10),
    overdue: isOverdue(row.dueOn, row.status, today),
    status: JOB_STATUS_FROM_DB[row.status],
    assignedTo: row.assignedTo,
  };
}

export function toJob(row: JobFullRow, today: Date = new Date()): Job {
  return {
    ...toJobSummary(row, today),
    draftVersion: row.draftVersion,
    templateRevision: toTemplateRevision({
      ...row.templateRevision,
      items: row.templateRevision.items,
      measurements: row.templateRevision.measurements,
    }),
    itemResults: row.itemResults.map(toItemResult),
    measurementResults: row.measurementResults.map(toMeasurementResult),
    partsUsed: row.partsUsed.map(toPartUsed),
    attachments: row.attachments.map(toAttachment),
  };
}

export function toItemResult(row: ItemResultRow): ItemResult {
  return {
    id: row.id,
    templateItemId: row.templateItemId,
    status: ITEM_STATUS_FROM_DB[row.status],
    remark: row.remark,
    clientRecordedAt: row.clientRecordedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

export function toMeasurementResult(row: MeasurementResultRow): MeasurementResult {
  return {
    id: row.id,
    templateMeasurementId: row.templateMeasurementId,
    readingNumeric: row.readingNumeric ? row.readingNumeric.toNumber() : null,
    readingText: row.readingText,
    judgement: JUDGEMENT_FROM_DB[row.judgement],
    remark: row.remark,
    clientRecordedAt: row.clientRecordedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

export function toPartUsed(row: PartUsedRow): PartUsed {
  return {
    id: row.id,
    partNo: row.partNo,
    description: row.description,
    quantity: row.quantity.toNumber(),
    remarks: row.remarks,
  };
}

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    itemResultId: row.itemResultId,
    originalFilename: row.originalFilename,
    contentType: row.contentType as AttachmentContentType,
    byteSize: Number(row.byteSize),
    sha256: Buffer.from(row.sha256).toString('hex'),
    uploadState: row.uploadState as 'pending' | 'received',
    uploadedAt: row.uploadedAt.toISOString(),
  };
}

// Re-exported so callers building a checklist view (submission gate,
// job read) can reuse the SAME template-item/measurement shape templates/
// already established, without duplicating the mapping.
export { toTemplateItem, toTemplateMeasurement };
