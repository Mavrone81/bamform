import type {
  ApprovalStep as ApprovalStepRow,
  Attachment as AttachmentRow,
  ItemResult as ItemResultRow,
  MeasurementResult as MeasurementResultRow,
  PartUsed as PartUsedRow,
} from '@prisma/client';
import { titleHasFillableRun } from '@bamform/shared';
import type {
  ApprovalStep,
  Attachment,
  AttachmentContentType,
  ItemResult,
  Job,
  JobSummary,
  MeasurementResult,
  PartUsed,
} from '@bamform/shared';
import { toTemplateItem, toTemplateMeasurement, toTemplateRevision } from '../templates/mappers';
import {
  approvalActionFromDb,
  ITEM_STATUS_FROM_DB,
  JOB_STATUS_FROM_DB,
  JUDGEMENT_FROM_DB,
} from './job-enums';
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
    assetDocumentId: row.assetDocumentId,
    documentNumber: row.templateRevision.formTemplate.documentNumber,
    revisionCode: row.templateRevision.revisionCode,
    frequency: row.frequency,
    frequencyScope: row.frequencyScope,
    dueOn: row.dueOn.toISOString().slice(0, 10),
    overdue: isOverdue(row.dueOn, row.status, today),
    status: JOB_STATUS_FROM_DB[row.status],
    assignedTo: row.assignedTo,
    // UR-028 (slice 18-WORKFLOW, review X-4) — off-plan work is visibly
    // different from planned work in every list that shows jobs, including
    // the `/reports/overdue` and `/reports/pending` worklists.
    isAdhoc: row.isAdhoc,
  };
}

export function toJob(row: JobFullRow, today: Date = new Date()): Job {
  return {
    ...toJobSummary(row, today),
    draftVersion: row.draftVersion,
    // Slice 31-TITLEBLANK — the technician's entry for the blank in this
    // record's title. Null until they fill it. On `Job`, not `JobSummary`:
    // the capture screen and the offline bootstrap both read the full job,
    // and no list view renders a resolved title.
    titleMachineNumber: row.titleMachineNumber,
    // DERIVED here, never stored — same rule as `asset-documents.service.ts`.
    // The capture screen shows its field only when this is true, so the one
    // implementation of "is there a blank" stays on the server and the
    // client cannot drift from the submit gate that uses it.
    titleHasFillableRun: titleHasFillableRun(row.templateRevision.formTemplate.title),
    // Slice 17-VOID annotation — null until a job is voided. Never part of
    // the signed canonical content (see canonical-job-record.ts's key pins).
    voidReason: row.voidReason,
    voidedBy: row.voidedBy,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    templateRevision: toTemplateRevision({
      ...row.templateRevision,
      items: row.templateRevision.items,
      measurements: row.templateRevision.measurements,
    }),
    itemResults: row.itemResults.map(toItemResult),
    measurementResults: row.measurementResults.map(toMeasurementResult),
    partsUsed: row.partsUsed.map(toPartUsed),
    attachments: row.attachments.map(toAttachment),
    approvalSteps: row.approvalSteps.map(toApprovalStep),
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

/**
 * PR-093/PR-094/PR-035 — never maps `drawnSignatureCt`/`drawnSignatureDekVersion`
 * (the encrypted personal-data drawn signature): `openapi.yaml`'s `ApprovalStep`
 * schema has no drawn-signature field, and rendering it back is the
 * verifier-queue UI's concern (slice 11), not this read path.
 */
export function toApprovalStep(row: ApprovalStepRow): ApprovalStep {
  return {
    id: row.id,
    stageOrdinal: row.stageOrdinal,
    // Slice 26-TWOSTAGE M1: the caption snapshotted at signing time. The
    // contract has carried `stageLabel` since slice 1 but nothing ever
    // populated it, which is why three hard-coded copies drifted apart.
    // `?? undefined` keeps it OFF the JSON entirely for the rows that have
    // no snapshot, rather than emitting a null the clients would have to
    // distinguish from "not applicable".
    stageLabel: row.stageLabel ?? undefined,
    action: approvalActionFromDb(row.action),
    actorId: row.actorId,
    actorRoleCode: row.actorRoleCode,
    reason: row.reason,
    actedAt: row.actedAt.toISOString(),
    signingKeyId: row.signingKeyId,
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
