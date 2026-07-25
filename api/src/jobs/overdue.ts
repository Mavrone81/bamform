import { JobStatusT } from '@prisma/client';

/** A job in one of these statuses can never be "overdue" — it is no longer open work. */
const TERMINAL_STATUSES: ReadonlySet<JobStatusT> = new Set([
  JobStatusT.verified,
  JobStatusT.archived,
  JobStatusT.voided,
]);

/**
 * PR-043 / BUILD_HANDOFF non-negotiable #12: "Overdue is derived, never
 * stored." `due_on < today AND status NOT IN (VERIFIED, ARCHIVED, VOIDED)`.
 * `today` defaults to `new Date()` but is injectable for deterministic tests.
 */
export function isOverdue(dueOn: Date, status: JobStatusT, today: Date = new Date()): boolean {
  if (TERMINAL_STATUSES.has(status)) {
    return false;
  }
  return dateOnly(dueOn) < dateOnly(today);
}

function dateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
