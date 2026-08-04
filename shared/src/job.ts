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
  /**
   * Slice 27-ASSETDOC — WHICH of the machine's documents this job records.
   * Without it a client cannot tell which document a record belongs to, and
   * slice 28's form picker cannot map a job back to the form it came from.
   */
  assetDocumentId: z.string().uuid(),
  documentNumber: z.string().optional(),
  revisionCode: z.string().optional(),
  frequency: frequencySchema,
  frequencyScope: z.array(frequencySchema).optional(),
  dueOn: z.string(),
  overdue: z.boolean().optional(),
  status: jobStatusSchema,
  assignedTo: z.string().uuid().nullable().optional(),
  assignedToName: z.string().nullable().optional(),
  /**
   * UR-028 — raised OFF-PLAN rather than generated from the maintenance
   * schedule (slice 18-WORKFLOW; added on review finding X-4).
   *
   * Every list that shows jobs shows both kinds, and the two mean different
   * things: an ad-hoc job satisfies no schedule period and is excluded from
   * UR-067 plan compliance. The `/reports/overdue` and `/reports/pending`
   * worklists deliberately KEEP ad-hoc rows — an overdue breakdown is real
   * outstanding work and hiding it would be a worse defect than counting it —
   * so this flag is what stops those numbers being ambiguous.
   */
  isAdhoc: z.boolean().optional(),
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

/**
 * `PUT /jobs/{id}/parts/{partId}` request body — slice 30. Client-keyed
 * create-or-update (the client mints `partId`, offline-friendly and
 * idempotent-replay-friendly, unlike the `POST` above's server-assigned id).
 * `active: false` is the soft-remove path (BUILD_HANDOFF non-negotiable #7 —
 * no physical `DELETE`); `active` never enters the canonical signed record.
 */
export const partUpsertInputSchema = z.object({
  partNo: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1),
  quantity: z.number().positive(),
  remarks: z.string().nullable().optional(),
  active: z.boolean().optional().default(true),
});
export type PartUpsertInput = z.infer<typeof partUpsertInputSchema>;

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

// -------------------------------------------------------------- approval_step

/**
 * PR-035/PR-041..046/PR-070..077/PR-093/PR-094 — mirrors `api/openapi.yaml`'s
 * `ApprovalStep`. The drawn signature (base64 PNG data-URL) is never returned
 * here — it is captured on `POST /jobs/{id}/verify` (`VerifyJobRequest`
 * below) and stored encrypted; rendering it back is the verifier-queue UI's
 * concern (slice 11), not this response shape.
 */
export const approvalActionSchema = z.enum([
  'SUBMITTED',
  'VERIFIED',
  'RETURNED',
  'RECALLED',
  'VOIDED',
]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const approvalStepSchema = z.object({
  id: z.string().uuid(),
  stageOrdinal: z.number().int(),
  stageLabel: z.string().optional(),
  action: approvalActionSchema,
  actorId: z.string().uuid().optional(),
  actorName: z.string().optional(),
  actorRoleCode: z.string().optional(),
  onBehalfOfName: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  actedAt: z.string(),
  signingKeyId: z.string().optional(),
});
export type ApprovalStep = z.infer<typeof approvalStepSchema>;

// ------------------------------------------------- job.title_machine_number

/**
 * The value the TECHNICIAN writes into the blank in the form's title
 * (`ED____` -> `ED01`). Bounds deliberately identical to
 * `asset.ts#assetDocumentCreateSchema.machineNumber`, the admin-set value it
 * overrides: trimmed, 1..50 — one blank, one set of rules, whoever fills it.
 */
export const titleMachineNumberSchema = z
  .string()
  .trim()
  .min(1, 'form number must not be empty')
  .max(50, 'form number must be 50 characters or fewer');

/**
 * `PUT /jobs/{id}/title-machine-number` request body — the per-record capture
 * of the title's blank.
 *
 * Explicitly NULLABLE and never required here: a draft may be saved, and a
 * whole shift worked offline, with the blank still empty (the paper form is
 * filled in the same order). `null` is how a mistyped value is CLEARED — an
 * empty string is rejected rather than quietly stored, so nothing can put a
 * zero-width value into a controlled title. The requirement bites at SUBMIT
 * (`submission.service.ts`), and only for a title that actually carries a
 * fillable run (`titleHasFillableRun`).
 */
export const titleMachineNumberInputSchema = z.object({
  titleMachineNumber: titleMachineNumberSchema.nullable(),
});
export type TitleMachineNumberInput = z.infer<typeof titleMachineNumberInputSchema>;

// ------------------------------------------------------------------------- job

export const jobSchema = jobSummarySchema.extend({
  draftVersion: z.number().int().optional(),
  /**
   * What the technician wrote into the title's blank ON THIS RECORD, or null
   * while it is still empty. NOT pre-filled from the machine code: deciding
   * which part of `AVS35-01` belongs in `AVS 35-____` is unverifiable and
   * wrong on two of the eight real shapes, so the box starts empty and the
   * technician types what is printed on the machine.
   *
   * Substituted at RENDER (`resolveTemplateTitle`), never stored resolved.
   * The PDF prefers this over the admin-set `asset_document.machineNumber`,
   * which remains the fallback so every record signed before this field
   * existed keeps printing exactly as it did.
   */
  titleMachineNumber: z.string().nullable().optional(),
  /**
   * Whether this record's title carries a fillable run of underscores, and so
   * whether the technician is offered a box for it at all. DERIVED per
   * response from the frozen revision's template title
   * (`titleHasFillableRun`), never stored — the same shape and the same
   * reasoning as `assetDocumentSchema.titleHasFillableRun`, which the admin
   * screen already keys its form-number field off.
   *
   * It exists so the ONE implementation of "is there a blank" stays
   * server-side: a second copy of that regex in the client is exactly the
   * drift slice 26 had to unpick for stage labels, and the title of a
   * controlled document is not the place to repeat it. A form with the number
   * pre-printed (EP01, PM01) or with no machine designation at all reports
   * false, and a technician is never shown a box that does nothing.
   *
   * There is deliberately NO `resolvedTitle` counterpart here (unlike
   * `AssetDocument`): a cached job's resolved title is whatever the server
   * last said, which goes stale the moment the technician types a number
   * offline. Showing it would state a printed title that is not the one this
   * record will print.
   */
  titleHasFillableRun: z.boolean().optional(),
  // Slice 17-VOID — the void ANNOTATION (never part of the signed record
  // content): populated only once a job is VOIDED. `voidedAt` is null for
  // voids that predate the column (slice 17's migration adds it).
  voidReason: z.string().nullable().optional(),
  voidedBy: z.string().uuid().nullable().optional(),
  voidedAt: z.string().nullable().optional(),
  templateRevision: templateRevisionSchema.optional(),
  itemResults: z.array(itemResultSchema).optional(),
  measurementResults: z.array(measurementResultSchema).optional(),
  partsUsed: z.array(partUsedSchema).optional(),
  attachments: z.array(attachmentSchema).optional(),
  approvalSteps: z.array(approvalStepSchema).optional(),
});
export type Job = z.infer<typeof jobSchema>;

// ------------------------------------------------ approval transition bodies

/**
 * `POST /jobs/{id}/verify` request body (PR-093/094, SAMUEL'S CONFIRMED
 * DECISIONS in slice-7-brief.md). `drawnSignature` is a base64 PNG data-URL
 * (`data:image/png;base64,...` or bare base64 — the server strips a data-URL
 * prefix if present) captured by the on-system signature pad (slice 11 builds
 * the pad UI; this slice validates + stores what it sends). `onBehalfOf` is
 * the delegator's user id when the actor is standing in under an active
 * delegation (PR-076) — omitted/absent when acting on their own authority.
 */
export const verifyJobRequestSchema = z.object({
  drawnSignature: z.string().min(1, 'drawnSignature is required (base64 PNG data-URL).'),
  onBehalfOf: z.string().uuid().nullable().optional(),
  comment: z.string().nullable().optional(),
});
export type VerifyJobRequest = z.infer<typeof verifyJobRequestSchema>;

/**
 * `POST /jobs/{id}/submit` request body — slice 18-WORKFLOW.
 *
 * The PERFORMER's signature. The owner's process (2026-07-28) is explicit:
 * "Completed work — team member will sign and submit to team lead for
 * checks". Until this slice submit recorded only who and when; the paper
 * forms carry three signatures and the system captured two. Same shape and
 * the same server-side handling as `VerifyJobRequest.drawnSignature` (base64
 * PNG data-URL, magic-byte validated, field-encrypted, never logged) — the
 * SAME `SignaturePad` captures it, which supports stylus AND mouse through
 * one pointer-event code path.
 *
 * MANDATORY, not optional: an unsigned submission asserts nothing, and the
 * signature is what binds a named human to "I did this work". There is
 * deliberately no config flag — see slice-18-workflow-report.md §1.
 */
export const submitJobRequestSchema = z.object({
  drawnSignature: z.string().min(1, 'drawnSignature is required (base64 PNG data-URL).'),
});
export type SubmitJobRequest = z.infer<typeof submitJobRequestSchema>;

/**
 * `POST /jobs/adhoc` request body — UR-028/PR-058, deferred in slice 5 and
 * picked up in slice 18-WORKFLOW. Raises a job against an asset OUTSIDE the
 * maintenance plan.
 *
 * `reason` is mandatory and >= 10 characters, the same "a reason under 10
 * characters isn't a reason" convention as void (INV-12), return (INV-13)
 * and the schedule adjustment — and it is backed by a database CHECK
 * (`job_adhoc_reason_length_chk`), not the service alone.
 *
 * `frequency` labels which depth of the frozen checklist is being performed;
 * it is NOT derived, because guessing it would put an untruth into a signed
 * record. It does NOT make the job count against the plan: an ad-hoc job is
 * created with an EMPTY `frequencyScope`, which is what makes it structurally
 * incapable of advancing `schedule_rule.next_due_on` (see the report's
 * independence proof).
 */
export const createAdhocJobRequestSchema = z.object({
  assetId: z.string().uuid(),
  /**
   * Slice 27-ASSETDOC — WHICH of the machine's documents this off-plan work is
   * recorded on. Optional only where there is nothing to choose: a machine
   * carrying exactly one active document. Where it carries several, the planner
   * must say, because the document decides which checklist gets frozen onto the
   * job — picking one silently would put the pH-meter checklist on a
   * preventive-maintenance call-out.
   */
  assetDocumentId: z.string().uuid().optional(),
  frequency: frequencySchema,
  reason: z
    .string()
    .trim()
    .min(10, 'reason must be at least 10 characters (UR-028 — why this work is off-plan).'),
  /** `YYYY-MM-DD`. Defaults to today (the work is being raised now). */
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dueOn must be a YYYY-MM-DD date.')
    .optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});
export type CreateAdhocJobRequest = z.infer<typeof createAdhocJobRequestSchema>;

/**
 * `POST /jobs/{id}/assign` request body — UR-029/PR-030 (slice 15-SYSWIRE,
 * system-review SYS-2). `assigneeId` is the user the job is (re)assigned to;
 * the server validates the assignee exists, is active, holds a
 * result-recording role and can reach the job's area.
 */
export const assignJobRequestSchema = z.object({
  assigneeId: z.string().uuid(),
});
export type AssignJobRequest = z.infer<typeof assignJobRequestSchema>;

/**
 * `GET /jobs/{jobId}/assignable-users` — slice 32-PLANNERJOB.
 *
 * WHY THIS ENDPOINT EXISTS. `POST /jobs/{jobId}/assign` is open to
 * PLANNER/TEAM_LEADER/ENGINEER/ADMIN, but `GET /users` is `@Roles('ADMIN')`,
 * so three of the four roles that may assign had no way to find out WHO they
 * could assign to. A picker built on a list those callers cannot read is not a
 * picker; a picker built on a list that is not filtered the server's way is
 * worse — it offers people the server will refuse with a 422 the planner can
 * do nothing about.
 *
 * So this returns exactly the users `AssignmentService#assertAssignableUser`
 * would accept FOR THIS JOB: active, holding a result-recording role
 * (MAINTAINER/TEAM_LEADER/ENGINEER — API_SPECIFICATION.md §4.1), and area-
 * scoped to reach the job's own area. The same service owns both the list and
 * the check, so they cannot drift.
 *
 * DELIBERATELY NARROWER THAN `User`. Name and roles are what a planner needs
 * to choose; email and employee id are personal data this caller has no reason
 * to receive, and `GET /users` stays the ADMIN-only place they live.
 */
export const assignableUserSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  /**
   * The result-recording roles this user holds — the reason they are on the
   * list. Sent so the picker can say WHY someone is offered, rather than
   * presenting a bare list of names a planner has to know by heart.
   */
  roles: z.array(z.string()),
});
export type AssignableUser = z.infer<typeof assignableUserSchema>;

/** `POST /jobs/{id}/return` request body — PR-074/INV-13, reason mandatory, >= 10 chars. */
export const returnJobRequestSchema = z.object({
  reason: z.string().trim().min(10, 'reason must be at least 10 characters (INV-13, PR-074).'),
});
export type ReturnJobRequest = z.infer<typeof returnJobRequestSchema>;

/** `POST /jobs/{id}/void` request body — PR-046/INV-12, reason mandatory, >= 10 chars. */
export const voidJobRequestSchema = z.object({
  reason: z.string().trim().min(10, 'reason must be at least 10 characters (INV-12, PR-046).'),
});
export type VoidJobRequest = z.infer<typeof voidJobRequestSchema>;

// --------------------------------------------------------------- integrity

/** `GET /records/{id}/integrity` response — PR-095/AC-11. Mirrors `api/openapi.yaml`'s `IntegrityResult`. */
export const integrityResultSchema = z.object({
  recordId: z.string().uuid(),
  intact: z.boolean(),
  checkedAt: z.string(),
  // Slice 17-VOID — the integrity surface must TELL THE TRUTH about a voided
  // record: the signatures still verify (the content never changed) AND the
  // record is void. `voided` is always populated; the reason/timestamp only
  // when voided.
  voided: z.boolean().optional(),
  voidReason: z.string().nullable().optional(),
  voidedAt: z.string().nullable().optional(),
  signatures: z
    .array(
      z.object({
        approvalStepId: z.string().uuid(),
        signerName: z.string().optional(),
        actedAt: z.string(),
        signingKeyId: z.string(),
        hashMatches: z.boolean(),
        signatureValid: z.boolean(),
      }),
    )
    .optional(),
  mismatchDetail: z.string().nullable().optional(),
});
export type IntegrityResult = z.infer<typeof integrityResultSchema>;

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
