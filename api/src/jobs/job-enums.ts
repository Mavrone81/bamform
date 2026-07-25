import { ItemStatusT, JobStatusT, JudgementT } from '@prisma/client';
import type { ItemStatus, JobStatus, Judgement } from '@bamform/shared';

/** DBD §5 `job_status_t` <-> `api/openapi.yaml` `JobStatus`. */
export const JOB_STATUS_FROM_DB: Record<JobStatusT, JobStatus> = {
  [JobStatusT.scheduled]: 'SCHEDULED',
  [JobStatusT.assigned]: 'ASSIGNED',
  [JobStatusT.in_progress]: 'IN_PROGRESS',
  [JobStatusT.submitted]: 'SUBMITTED',
  [JobStatusT.verified]: 'VERIFIED',
  [JobStatusT.archived]: 'ARCHIVED',
  [JobStatusT.voided]: 'VOIDED',
};

export const JOB_STATUS_TO_DB: Record<JobStatus, JobStatusT> = {
  SCHEDULED: JobStatusT.scheduled,
  ASSIGNED: JobStatusT.assigned,
  IN_PROGRESS: JobStatusT.in_progress,
  SUBMITTED: JobStatusT.submitted,
  VERIFIED: JobStatusT.verified,
  ARCHIVED: JobStatusT.archived,
  VOIDED: JobStatusT.voided,
};

/** DBD §5 `item_status_t` <-> `api/openapi.yaml` `ItemStatus`. */
export const ITEM_STATUS_FROM_DB: Record<ItemStatusT, ItemStatus> = {
  [ItemStatusT.done]: 'DONE',
  [ItemStatusT.not_applicable]: 'NOT_APPLICABLE',
  [ItemStatusT.not_done]: 'NOT_DONE',
};

export const ITEM_STATUS_TO_DB: Record<ItemStatus, ItemStatusT> = {
  DONE: ItemStatusT.done,
  NOT_APPLICABLE: ItemStatusT.not_applicable,
  NOT_DONE: ItemStatusT.not_done,
};

/** DBD §5 `judgement_t` <-> `api/openapi.yaml` `Judgement`. */
export const JUDGEMENT_FROM_DB: Record<JudgementT, Judgement> = {
  [JudgementT.pass]: 'PASS',
  [JudgementT.fail]: 'FAIL',
  [JudgementT.not_evaluated]: 'NOT_EVALUATED',
};

export const JUDGEMENT_TO_DB: Record<Judgement, JudgementT> = {
  PASS: JudgementT.pass,
  FAIL: JudgementT.fail,
  NOT_EVALUATED: JudgementT.not_evaluated,
};

/** `job_status_t` values a mutation (item/measurement/part/attachment) may target. */
export const JOB_WRITABLE_STATUSES: readonly JobStatusT[] = [
  JobStatusT.assigned,
  JobStatusT.in_progress,
];
