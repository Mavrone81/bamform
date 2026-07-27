import { JobStatusT } from '@prisma/client';
import { invalidTransitionProblem } from '../common/domain-problems';

/**
 * PRD §5.1 job lifecycle, expressed as a pure, exhaustively-testable table —
 * U-STM-01/02/03 (docs/TEST_PLAN.md §5.4). This is deliberately a NEW,
 * standalone module rather than a rewrite of `job-status-guard.ts`'s
 * `assertJobWritable` (slice 6, frozen/unmodified — used only for
 * result/part/attachment capture) or `submission.service.ts`'s inline
 * `IN_PROGRESS -> SUBMITTED` check: this table is the full lifecycle,
 * covering the slice-7 transitions those two never needed to know about
 * (`VERIFY_ADVANCE`/`VERIFY_FINAL`/`RETURN`/`RECALL`/`VOID`), so it can be
 * unit-tested exhaustively without touching slice-6 code.
 *
 * `VERIFY_ADVANCE` = a non-final stage's verify (stays `SUBMITTED`, stage
 * ordinal advances). `VERIFY_FINAL` = the last stage's verify — PR-042/
 * INV-13: `SUBMITTED -> ARCHIVED` directly, in the same transaction, so
 * `VERIFIED` is never a resting state a row's `status` column holds (it
 * remains a legal logical milestone — `approval_step.action = 'verified'` is
 * still recorded — just never the job's own `status`).
 */
export type JobTransition =
  'ASSIGN' | 'START' | 'SUBMIT' | 'VERIFY_ADVANCE' | 'VERIFY_FINAL' | 'RETURN' | 'RECALL' | 'VOID';

const LEGAL_TRANSITIONS: Record<JobStatusT, readonly JobTransition[]> = {
  [JobStatusT.scheduled]: ['ASSIGN', 'VOID'],
  // Slice 15-SYSWIRE (SYS-2) — UR-029 says "assignable ... and REASSIGNABLE":
  // `ASSIGN` from ASSIGNED or IN_PROGRESS is a reassignment — the assignee is
  // replaced and the status does NOT change (PRD §5.1's SCHEDULED->ASSIGNED
  // edge is the only status effect of assignment). Without these edges a job
  // whose assignee is deactivated (13a) is permanently stranded: its only
  // exit would be VOID, losing the record.
  [JobStatusT.assigned]: ['ASSIGN', 'START', 'VOID'],
  [JobStatusT.in_progress]: ['ASSIGN', 'SUBMIT', 'VOID'],
  [JobStatusT.submitted]: ['VERIFY_ADVANCE', 'VERIFY_FINAL', 'RETURN', 'RECALL', 'VOID'],
  // VERIFIED never rests as a `job.status` value (PR-042) but is listed here,
  // empty, so the table stays total over every `JobStatusT` member (U-STM-03
  // asserts the terminal states' emptiness).
  [JobStatusT.verified]: [],
  // Slice 17-VOID — the owner's 2026-07-27 decision ("Void is also possible
  // after the full process is completed") amends PR-041's "ARCHIVED is
  // terminal": ARCHIVED's ONE exit is VOID. The transition is an ANNOTATION,
  // never a mutation — the double-signed record content, signatures, content
  // hash and audit chain are byte-identical before and after; only the void
  // annotation fields (`status`/`void_reason`/`voided_by`/`voided_at`) change,
  // enforced by the amended `job_archived_immutable_trg`. Post-archive void is
  // ADMIN-only with a mandatory reason (`ApprovalTransitionsService#void_`).
  [JobStatusT.archived]: ['VOID'],
  // VOIDED is terminal and DB-immutable (`prevent_archived_job_update` also
  // raises for OLD.status = 'voided' since slice 17 — the SYS-18 backstop).
  [JobStatusT.voided]: [],
};

export function isLegalTransition(from: JobStatusT, transition: JobTransition): boolean {
  return LEGAL_TRANSITIONS[from].includes(transition);
}

/** Throws RFC 9457 `/errors/invalid-transition` (409) unless `transition` is legal from `from`. */
export function assertLegalTransition(from: JobStatusT, transition: JobTransition): void {
  if (!isLegalTransition(from, transition)) {
    throw invalidTransitionProblem(
      `Job is ${from} — ${transition} is not a legal transition from this state (PRD §5.1).`,
    );
  }
}

/** Every `JobStatusT` member, for exhaustive-matrix tests (U-STM-02). */
export const ALL_JOB_STATUSES: readonly JobStatusT[] = Object.values(JobStatusT);

/** Every `JobTransition`, for exhaustive-matrix tests (U-STM-02). */
export const ALL_TRANSITIONS: readonly JobTransition[] = [
  'ASSIGN',
  'START',
  'SUBMIT',
  'VERIFY_ADVANCE',
  'VERIFY_FINAL',
  'RETURN',
  'RECALL',
  'VOID',
];
