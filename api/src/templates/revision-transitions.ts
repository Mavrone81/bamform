import { RevisionStatusT } from '@prisma/client';
import { invalidTransitionProblem, selfApprovalProblem } from '../common/domain-problems';

/**
 * PRD §5.2 state machine, enforced as pure guard functions so the lifecycle
 * legality is unit-testable without a database (the DB triggers/constraints
 * — INV-01..04 — are the backstop for the SAME rules; see the `catch`
 * blocks in `revisions.service.ts`, which translate a genuine DB-level
 * rejection into the same clean domain error these guards raise).
 */

/** DRAFT → edit / replace items / replace measurements / submit. */
export function assertDraft(status: RevisionStatusT): void {
  if (status !== RevisionStatusT.draft) {
    throw invalidTransitionProblem(
      `Revision is ${status}; this action is only valid while the revision is DRAFT.`,
    );
  }
}

/** PENDING_APPROVAL → approve / reject. */
export function assertPendingApproval(status: RevisionStatusT): void {
  if (status !== RevisionStatusT.pending_approval) {
    throw invalidTransitionProblem(
      `Revision is ${status}; this action is only valid while the revision is PENDING_APPROVAL.`,
    );
  }
}

/** PR-047/INV-03: the approver must differ from the revision's author. */
export function assertNotSelfApproval(authoredBy: string, actorId: string): void {
  if (authoredBy === actorId) {
    throw selfApprovalProblem('You authored this revision and cannot approve your own work.');
  }
}

/** INV-02: the next revision for a template is always `max(existing) + 1`, or 0 if none exist. */
export function nextSequenceOrdinal(currentMax: number | null): number {
  return currentMax === null ? 0 : currentMax + 1;
}
