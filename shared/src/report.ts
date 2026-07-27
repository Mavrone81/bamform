import { z } from 'zod';
import { jobSummarySchema, judgementSchema } from './job';

/**
 * Slice 12 — `GET /records` (archive search, UR-058), `GET /records/{id}/pdf`
 * (PR-116..118), `POST /records/export` / `GET /exports/{id}` (PR-119), and
 * the `/reports/*` surface (PRD §9). Mirrors `api/openapi.yaml` exactly
 * where a path exists there (BUILD_HANDOFF §1).
 */

// ------------------------------------------------------ GET /records query params

/** UR-058: "search and filter the archive by asset, asset type, document number, frequency, date range, technician and approver." */
export const listRecordsQuerySchema = z.object({
  limit: z.union([z.string(), z.number()]).optional(),
  cursor: z.string().optional(),
  assetId: z.string().uuid().optional(),
  assetTypeId: z.string().uuid().optional(),
  documentNumber: z.string().optional(),
  frequency: z.enum(['M1', 'M3', 'M6', 'Y']).optional(),
  archivedFrom: z.string().optional(),
  archivedTo: z.string().optional(),
  technician: z.string().uuid().optional(),
  approver: z.string().uuid().optional(),
  /**
   * Slice 17-VOID — omitted: whole archive INCLUDING voided-archived records
   * (auditors must see voids); `true`: only voided; `false`: exclude voided.
   * Accepts the string forms a query string delivers (same convention as
   * `listJobsQuerySchema.overdue`).
   */
  voided: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v === 'true' : v))
    .optional(),
});
export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>;

// --------------------------------------------------------------- POST /records/export

/**
 * At least one of `recordIds` (an explicit selection) or `filters` (the SAME
 * shape `GET /records` accepts, re-run at export time) must be supplied — a
 * bare `{}` would silently mean "export nothing", which is `422`, not `200`
 * with an empty ZIP (see `records-export.service.ts`).
 */
export const recordExportRequestSchema = z
  .object({
    recordIds: z.array(z.string().uuid()).max(500).optional(),
    filters: listRecordsQuerySchema.omit({ limit: true, cursor: true }).optional(),
  })
  .refine((v) => (v.recordIds && v.recordIds.length > 0) || v.filters !== undefined, {
    message: 'Provide recordIds or filters — an empty export request is not valid.',
  });
export type RecordExportRequest = z.infer<typeof recordExportRequestSchema>;

export const recordExportStatusValues = ['PENDING', 'PROCESSING', 'DONE', 'FAILED'] as const;
export const recordExportStatusSchema = z.enum(recordExportStatusValues);
export type RecordExportStatus = z.infer<typeof recordExportStatusSchema>;

/** `GET /exports/{id}` response. `downloadPath` is only populated once `status === 'DONE'` — the api-relative path to `GET /exports/{id}/download` (ADR-007: streamed, authorised on every fetch, never a presigned URL). */
export const recordExportStatusResponseSchema = z.object({
  id: z.string().uuid(),
  status: recordExportStatusSchema,
  recordCount: z.number().int(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  failedReason: z.string().nullable().optional(),
  downloadPath: z.string().nullable(),
});
export type RecordExportStatusResponse = z.infer<typeof recordExportStatusResponseSchema>;

// ------------------------------------------------------------ GET /reports/measurements

export const measurementTrendPointSchema = z.object({
  recordId: z.string().uuid(),
  performedOn: z.string(),
  revisionCode: z.string(),
  reading: z.number().nullable(),
  judgement: judgementSchema,
});
export type MeasurementTrendPoint = z.infer<typeof measurementTrendPointSchema>;

/** Mirrors `api/openapi.yaml`'s `MeasurementTrend`. */
export const measurementTrendSchema = z.object({
  assetCode: z.string(),
  stableKey: z.string(),
  description: z.string().optional(),
  unit: z.string().nullable().optional(),
  lowerLimit: z.number().nullable().optional(),
  upperLimit: z.number().nullable().optional(),
  points: z.array(measurementTrendPointSchema),
});
export type MeasurementTrend = z.infer<typeof measurementTrendSchema>;

export const measurementTrendQuerySchema = z.object({
  assetId: z.string().uuid(),
  stableKey: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type MeasurementTrendQuery = z.infer<typeof measurementTrendQuerySchema>;

// ------------------------------------------------------------- GET /reports/compliance

/** UR-067 — due vs. completed on time, grouped by area. */
export const complianceReportRowSchema = z.object({
  areaId: z.string().uuid().nullable(),
  areaCode: z.string().nullable(),
  dueCount: z.number().int(),
  completedOnTimeCount: z.number().int(),
  completedLateCount: z.number().int(),
  notCompletedCount: z.number().int(),
  compliancePercent: z.number(),
});
export type ComplianceReportRow = z.infer<typeof complianceReportRowSchema>;

export const complianceReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  rows: z.array(complianceReportRowSchema),
});
export type ComplianceReport = z.infer<typeof complianceReportSchema>;

export const complianceReportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  areaId: z.string().uuid().optional(),
});
export type ComplianceReportQuery = z.infer<typeof complianceReportQuerySchema>;

// ---------------------------------------------------- GET /reports/overdue

export const overdueReportSchema = z.object({
  data: z.array(jobSummarySchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number().int(),
  }),
});
export type OverdueReport = z.infer<typeof overdueReportSchema>;

// ------------------------------------------------- GET /reports/pending

/** UR-068 — submitted jobs awaiting verification, with ageing (hours since submission). */
export const pendingVerificationEntrySchema = jobSummarySchema.extend({
  submittedAt: z.string(),
  ageHours: z.number(),
});
export type PendingVerificationEntry = z.infer<typeof pendingVerificationEntrySchema>;

export const pendingReportSchema = z.object({
  data: z.array(pendingVerificationEntrySchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number().int(),
  }),
});
export type PendingReport = z.infer<typeof pendingReportSchema>;
