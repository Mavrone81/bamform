import { JobStatusT } from '@prisma/client';
import { invalidTransitionProblem, recordImmutableProblem } from '../common/domain-problems';
import { JOB_WRITABLE_STATUSES } from './job-enums';

/**
 * Result/part/attachment capture is only meaningful while a job is
 * `ASSIGNED` or `IN_PROGRESS` (PRD §5.1 job lifecycle). Every mutation
 * handler calls this FIRST — `ARCHIVED` maps to the more specific
 * `/errors/record-immutable` (INV-09/PR-041); anything else not-yet-writable
 * (`SCHEDULED`, `SUBMITTED`, `VERIFIED`, `VOIDED`) is a generic
 * `/errors/invalid-transition`.
 */
export function assertJobWritable(status: JobStatusT): void {
  if (JOB_WRITABLE_STATUSES.includes(status)) {
    return;
  }
  if (status === JobStatusT.archived) {
    throw recordImmutableProblem();
  }
  throw invalidTransitionProblem(
    `Job is ${status} — results can only be recorded while ASSIGNED or IN_PROGRESS.`,
  );
}
