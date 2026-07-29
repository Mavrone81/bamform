import type { Prisma } from '@prisma/client';

/**
 * `active: true` on the frozen revision's items/measurements — DP-3/PR-049:
 * a job is bound to the revision that was CURRENT when it was generated, but
 * only the still-active rows on that revision are ever shown/recordable
 * against (mirrors `templates/revisions.service.ts`'s `REVISION_INCLUDE`,
 * same reasoning: a soft-removed row must not resurface on a read path).
 */
export const JOB_SUMMARY_INCLUDE = {
  asset: true,
  templateRevision: { include: { formTemplate: true } },
} satisfies Prisma.JobInclude;

export const JOB_FULL_INCLUDE = {
  asset: true,
  // Slice 29 M-4 — the admin-filled machine number lives on the job's
  // asset_document; the signed/archived PDF resolves the fillable run in the
  // template title against it (`pdf-record-assembly.service.ts`). `Job.
  // assetDocumentId` is a required FK, so `assetDocument` is always present.
  assetDocument: true,
  templateRevision: {
    include: {
      formTemplate: true,
      items: { where: { active: true }, orderBy: { displayOrder: 'asc' as const } },
      measurements: { where: { active: true }, orderBy: { displayOrder: 'asc' as const } },
    },
  },
  itemResults: true,
  measurementResults: true,
  partsUsed: true,
  attachments: true,
  // Slice 7 — never includes the encrypted drawn-signature bytes in a
  // read path; `mappers.ts#toApprovalStep` maps only the non-personal
  // columns (see openapi.yaml's ApprovalStep schema, which has no
  // drawn-signature field).
  approvalSteps: { orderBy: { actedAt: 'asc' as const } },
} satisfies Prisma.JobInclude;

export type JobSummaryRow = Prisma.JobGetPayload<{ include: typeof JOB_SUMMARY_INCLUDE }>;
export type JobFullRow = Prisma.JobGetPayload<{ include: typeof JOB_FULL_INCLUDE }>;

/**
 * The MOST RECENT `approval_step`, if any — `integrity.service.ts#checkIntegrity`
 * recomputes/verifies exactly this row's `content_hash` (see its doc comment
 * for why only the newest step's hash is checked against current data).
 * `pdf-render.service.ts`'s footer digest (PR-118) reuses this SAME row's
 * `content_hash` rather than recomputing or inventing a separate value —
 * `approvalSteps` is ordered `actedAt ASC` by `JOB_FULL_INCLUDE`, so the last
 * array element is the newest.
 */
export function latestApprovalStep(job: JobFullRow): JobFullRow['approvalSteps'][number] | null {
  return job.approvalSteps.length > 0 ? job.approvalSteps[job.approvalSteps.length - 1] : null;
}
