import { z } from 'zod';
import { frequencySchema } from './frequency';

/**
 * DBD §6.9-6.12 `form_template` / `template_revision` / `template_item` /
 * `template_measurement` — PR-021..028. Mirrors `api/openapi.yaml`
 * `TemplateRevision`/`TemplateItem`/`TemplateMeasurement`/`StandingContent`
 * exactly where the path exists there (`openapi.yaml` is authoritative,
 * BUILD_HANDOFF §1); `PUT /revisions/{id}/items`, `POST .../submit` and
 * `POST .../reject` are not present in `openapi.yaml` at all (slice-4-report.md
 * flags this as a documentation gap against PRD §5.2 / API_SPECIFICATION.md
 * §10.4, which both describe them) — their shapes below follow the same
 * conventions as the sibling endpoints openapi.yaml does define.
 */

// ---------------------------------------------------------------- Revision status

export const revisionStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'CURRENT',
  'SUPERSEDED',
  'REJECTED',
]);
export type RevisionStatus = z.infer<typeof revisionStatusSchema>;

export const specTypeSchema = z.enum(['RANGE', 'TOLERANCE', 'PASS_FAIL', 'TEXT']);
export type SpecType = z.infer<typeof specTypeSchema>;

// -------------------------------------------------------------------- form_template

export const formTemplateSchema = z.object({
  id: z.string().uuid(),
  documentNumber: z.string(),
  title: z.string(),
  active: z.boolean(),
  // Slice 27-ASSETDOC removed `assetTypeId`. It was the reverse of
  // `asset_type.form_template_id @unique` — "the one machine family this
  // document belongs to" — and a document no longer belongs to one. Which
  // machines carry it is read from `GET /assets/{id}/documents`.
  currentRevisionId: z.string().uuid().nullable().optional(),
});
export type FormTemplate = z.infer<typeof formTemplateSchema>;

/**
 * Slice 13-TL: `POST /templates` — the endpoint BAMFORM-TLP-001's load
 * tooling drives (PR-TLP-07: the load is an authenticated operation
 * attributable to a named person, producing audit events — not a DB
 * migration, PR-DBD-10). Content arrives through the slice-4 revision
 * authoring endpoints; this creates only the template shell.
 */
export const createTemplateRequestSchema = z.object({
  documentNumber: z.string().trim().min(1),
  title: z.string().trim().min(1),
});
export type CreateTemplateRequest = z.infer<typeof createTemplateRequestSchema>;

// -------------------------------------------------------------------- standing_content

export const partRequiredSchema = z.object({
  partNo: z.string().optional(),
  description: z.string().optional(),
  qty: z.string().optional(),
  remarks: z.string().optional(),
});

export const standingContentSchema = z.object({
  specialTools: z.string().nullable().optional(),
  partsRequired: z.array(partRequiredSchema).optional(),
  ppe: z.array(z.string()).optional(),
  safety: z.string().nullable().optional(),
  procedure: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
  /**
   * The form's printed frequency banner, VERBATIM (e.g. "Monthly (1M) Three
   * Monthly (3M) Six Monthly (6M) Yearly (Y)"). Loaded from the workbook so
   * the printed record can reproduce the paper's selection band.
   *
   * NOT derivable from the template's item frequencies: 5 of the 12 loaded
   * forms print options they have no items for — CE-95-012-00-02 has monthly
   * items only and prints all four.
   */
  frequencyBanner: z.string().nullable().optional(),
  cascadeOverride: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type StandingContent = z.infer<typeof standingContentSchema>;

// -------------------------------------------------------------------- template_item

/** Response shape — matches `openapi.yaml` `TemplateItem` (`id` required). */
export const templateItemSchema = z.object({
  id: z.string().uuid(),
  itemNo: z.number().int(),
  frequency: frequencySchema,
  instruction: z.string(),
  mandatory: z.boolean(),
  stableKey: z.string(),
  displayOrder: z.number().int().optional(),
});
export type TemplateItem = z.infer<typeof templateItemSchema>;

/**
 * `PUT /revisions/{id}/items` request element — `id` is never accepted from
 * the client (server-assigned); `stableKey` is optional so a genuinely new
 * item doesn't require the caller to mint one (PR-028's carry-forward is the
 * caller re-sending the SAME stableKey an existing item already has).
 */
export const templateItemInputSchema = z.object({
  itemNo: z.number().int().positive(),
  frequency: frequencySchema,
  instruction: z.string().trim().min(1),
  mandatory: z.boolean().optional().default(true),
  stableKey: z.string().trim().min(1).optional(),
  displayOrder: z.number().int().optional(),
});
export type TemplateItemInput = z.infer<typeof templateItemInputSchema>;

export const replaceItemsRequestSchema = z.array(templateItemInputSchema);
export type ReplaceItemsRequest = z.infer<typeof replaceItemsRequestSchema>;

// -------------------------------------------------------------- template_measurement

/**
 * Matches `openapi.yaml` `TemplateMeasurement` exactly — used as BOTH the
 * `PUT /revisions/{id}/measurements` request and response body there (`id`
 * is not in openapi's `required` list, so it is optional/ignored on input).
 */
export const templateMeasurementSchema = z.object({
  id: z.string().uuid().optional(),
  section: z.string().nullable().optional(),
  description: z.string().trim().min(1),
  unit: z.string().nullable().optional(),
  specType: specTypeSchema,
  lowerLimit: z.number().nullable().optional(),
  upperLimit: z.number().nullable().optional(),
  nominal: z.number().nullable().optional(),
  tolerance: z.number().nullable().optional(),
  specDisplay: z.string().trim().min(1),
  stableKey: z.string().trim().min(1),
  displayOrder: z.number().int().optional(),
});
export type TemplateMeasurement = z.infer<typeof templateMeasurementSchema>;

export const replaceMeasurementsRequestSchema = z.array(templateMeasurementSchema);
export type ReplaceMeasurementsRequest = z.infer<typeof replaceMeasurementsRequestSchema>;

// ------------------------------------------------------------------ template_revision

export const templateRevisionSchema = z.object({
  id: z.string().uuid(),
  formTemplateId: z.string().uuid(),
  documentNumber: z.string().optional(),
  title: z.string().optional(),
  revisionCode: z.string(),
  sequenceOrdinal: z.number().int(),
  status: revisionStatusSchema,
  changeDescription: z.string().optional(),
  standingContent: standingContentSchema.optional(),
  authoredBy: z.string().uuid().optional(),
  authoredByName: z.string().optional(),
  approvedBy: z.string().uuid().nullable().optional(),
  approvedByName: z.string().nullable().optional(),
  approvedAt: z.string().nullable().optional(),
  rejectedReason: z.string().nullable().optional(),
  effectiveFrom: z.string().nullable().optional(),
  supersededAt: z.string().nullable().optional(),
  items: z.array(templateItemSchema).optional(),
  measurements: z.array(templateMeasurementSchema).optional(),
});
export type TemplateRevision = z.infer<typeof templateRevisionSchema>;

// --------------------------------------------------- POST /templates/{id}/revisions

/** Matches `openapi.yaml` `createRevision` requestBody exactly. */
export const createRevisionRequestSchema = z.object({
  revisionCode: z.string().trim().min(1),
  changeDescription: z.string().trim().min(5),
});
export type CreateRevisionRequest = z.infer<typeof createRevisionRequestSchema>;

// ------------------------------------------------------------- PATCH /revisions/{id}

/** Not in `openapi.yaml` (gap, see file header) — draft-only metadata edit. */
export const patchRevisionRequestSchema = z.object({
  revisionCode: z.string().trim().min(1).optional(),
  changeDescription: z.string().trim().min(5).optional(),
  standingContent: standingContentSchema.optional(),
});
export type PatchRevisionRequest = z.infer<typeof patchRevisionRequestSchema>;

// ------------------------------------------------------------ POST .../reject

/** Not in `openapi.yaml` (gap, see file header) — PRD §5.2 "rejected with reason". */
export const rejectRevisionRequestSchema = z.object({
  reason: z.string().trim().min(10),
});
export type RejectRevisionRequest = z.infer<typeof rejectRevisionRequestSchema>;
