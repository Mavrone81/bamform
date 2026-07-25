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
