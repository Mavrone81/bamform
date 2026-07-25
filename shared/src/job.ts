import { z } from 'zod';
import { frequencySchema } from './frequency';
import { templateRevisionSchema } from './template';

/**
 * DBD §6.15-6.19 `job` / `item_result` / `measurement_result` / `part_used` /
 * `attachment` — PR-030..034, PR-045. Mirrors `api/openapi.yaml`'s
 * `Job`/`JobSummary`/`ItemResult(Input)`/`MeasurementResult(Input)`/
 * `PartUsed`/`Attachment` exactly where the path exists there (`openapi.yaml`
 * is authoritative, BUILD_HANDOFF §1); `PartUsedInput` is not present in
 * `openapi.yaml` for slices 1-5's era (it's a slice-6 addition, added here
 * AND in `openapi.yaml` together).
 */

// ---------------------------------------------------------------- job_status_t

export const jobStatusSchema = z.enum([
  'SCHEDULED',
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'VERIFIED',
  'ARCHIVED',
  'VOIDED',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const itemStatusSchema = z.enum(['DONE', 'NOT_APPLICABLE', 'NOT_DONE']);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

export const judgementSchema = z.enum(['PASS', 'FAIL', 'NOT_EVALUATED']);
export type Judgement = z.infer<typeof judgementSchema>;

// -------------------------------------------------------------------- job_summary

export const jobSummarySchema = z.object({
  id: z.string().uuid(),
  jobNumber: z.string(),
  assetId: z.string().uuid(),
  assetCode: z.string(),
  documentNumber: z.string().optional(),
  revisionCode: z.string().optional(),
  frequency: frequencySchema,
  frequencyScope: z.array(frequencySchema).optional(),
  dueOn: z.string(),
  overdue: z.boolean().optional(),
  status: jobStatusSchema,
  assignedTo: z.string().uuid().nullable().optional(),
  assignedToName: z.string().nullable().optional(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

// ------------------------------------------------------------------ item_result

/** `PUT /jobs/{id}/items/{templateItemId}` request body. */
export const itemResultInputSchema = z.object({
  status: itemStatusSchema,
  remark: z.string().nullable().optional(),
  clientRecordedAt: z.string().datetime({ offset: true }).optional(),
});
export type ItemResultInput = z.infer<typeof itemResultInputSchema>;

export const itemResultSchema = z.object({
  id: z.string().uuid(),
  templateItemId: z.string().uuid(),
  status: itemStatusSchema,
  remark: z.string().nullable().optional(),
  recordedByName: z.string().optional(),
  clientRecordedAt: z.string(),
  recordedAt: z.string(),
});
export type ItemResult = z.infer<typeof itemResultSchema>;

// ------------------------------------------------------------- measurement_result

/** `PUT /jobs/{id}/measurements/{templateMeasurementId}` request body. */
export const measurementResultInputSchema = z
  .object({
    readingNumeric: z.number().nullable().optional(),
    readingText: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
    clientRecordedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.readingNumeric != null || v.readingText != null, {
    message: 'One of readingNumeric or readingText is required.',
  });
export type MeasurementResultInput = z.infer<typeof measurementResultInputSchema>;

export const measurementResultSchema = z.object({
  id: z.string().uuid(),
  templateMeasurementId: z.string().uuid(),
  readingNumeric: z.number().nullable().optional(),
  readingText: z.string().nullable().optional(),
  judgement: judgementSchema,
  remark: z.string().nullable().optional(),
  recordedByName: z.string().optional(),
  clientRecordedAt: z.string(),
  recordedAt: z.string(),
});
export type MeasurementResult = z.infer<typeof measurementResultSchema>;

// ------------------------------------------------------------------- part_used

/**
 * `POST /jobs/{id}/parts` request body. Not in `openapi.yaml` before this
 * slice (added alongside it here) — UR-034/PR-033. No `DELETE` counterpart:
 * BUILD_HANDOFF non-negotiable #7 / `grants.sql` revoke `DELETE` on every
 * table for `bamform_app`, superseding API_SPECIFICATION.md §10.5's
 * documented `DELETE /jobs/{id}/parts/{partId}` (see slice-6-report.md).
 */
export const partUsedInputSchema = z.object({
  partNo: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1),
  quantity: z.number().positive(),
  remarks: z.string().nullable().optional(),
});
export type PartUsedInput = z.infer<typeof partUsedInputSchema>;

export const partUsedSchema = z.object({
  id: z.string().uuid(),
  partNo: z.string().nullable().optional(),
  description: z.string(),
  quantity: z.number(),
  remarks: z.string().nullable().optional(),
});
export type PartUsed = z.infer<typeof partUsedSchema>;

// -------------------------------------------------------------------- attachment

export const attachmentContentTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export type AttachmentContentType = z.infer<typeof attachmentContentTypeSchema>;

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  itemResultId: z.string().uuid().nullable().optional(),
  originalFilename: z.string().nullable().optional(),
  contentType: attachmentContentTypeSchema,
  byteSize: z.number().int(),
  sha256: z.string().optional(),
  uploadState: z.enum(['pending', 'received']),
  uploadedByName: z.string().optional(),
  uploadedAt: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

// ------------------------------------------------------------------------- job

export const jobSchema = jobSummarySchema.extend({
  draftVersion: z.number().int().optional(),
  templateRevision: templateRevisionSchema.optional(),
  itemResults: z.array(itemResultSchema).optional(),
  measurementResults: z.array(measurementResultSchema).optional(),
  partsUsed: z.array(partUsedSchema).optional(),
  attachments: z.array(attachmentSchema).optional(),
});
export type Job = z.infer<typeof jobSchema>;

// ------------------------------------------------------- GET /jobs query params

export const listJobsQuerySchema = z.object({
  limit: z.union([z.string(), z.number()]).optional(),
  cursor: z.string().optional(),
  status: jobStatusSchema.optional(),
  assignedTo: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  overdue: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .optional(),
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

// ------------------------------------------------------ outstanding-item shape

/**
 * PR-045/PR-API-13 — `/errors/incomplete-record`'s `errors[]` must list the
 * outstanding mandatory items, not just a count, so a technician can tap
 * straight to what's missing.
 */
export const outstandingItemSchema = z.object({
  templateItemId: z.string().uuid(),
  itemNo: z.number().int(),
  instruction: z.string(),
});
export type OutstandingItem = z.infer<typeof outstandingItemSchema>;
