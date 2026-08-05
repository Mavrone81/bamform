import { JobStatusT } from '@prisma/client';
import {
  ASSIGNABLE_JOB_STATUSES,
  NEVER_ASSIGNABLE_JOB_STATUSES,
  unassignedJobsForRuleWhere,
} from './rule-unassigned-jobs';
import { ALL_JOB_STATUSES, isLegalTransition } from './job-state-machine';

/**
 * Slice 33-APPLYDEFAULT — THE PREDICATE THE OFFER AND THE BATCH SHARE.
 *
 * The planner is shown a number and then presses a button that assigns exactly
 * that many jobs. Everything that could make those two disagree is decided
 * here, so this suite is about the FILTER rather than about SQL: which states
 * may be assigned, which jobs are genuinely unassigned, and that the set is
 * derived from the lifecycle table rather than typed out beside it.
 */
describe('rule-unassigned-jobs — which jobs a standing assignee may still be applied to', () => {
  describe('ASSIGNABLE_JOB_STATUSES', () => {
    it('is exactly the states POST /jobs/{jobId}/assign accepts', () => {
      expect([...ASSIGNABLE_JOB_STATUSES].sort()).toEqual(
        [JobStatusT.assigned, JobStatusT.in_progress, JobStatusT.scheduled].sort(),
      );
    });

    /**
     * The point of computing it rather than listing it. If a future slice adds
     * or removes an `ASSIGN` edge in `job-state-machine.ts`, this filter must
     * move with it — otherwise the count would offer a job the assign endpoint
     * would answer 409 for, in a screen whose whole promise is that the number
     * shown is the number that changes.
     */
    it('is DERIVED from the state machine, not a second copy of it', () => {
      for (const status of ALL_JOB_STATUSES) {
        expect(ASSIGNABLE_JOB_STATUSES.includes(status)).toBe(isLegalTransition(status, 'ASSIGN'));
      }
    });

    it('excludes every state in which a job has left the technician’s hands', () => {
      // SUBMITTED is with the approver, ARCHIVED is a signed record, VOIDED is
      // dead, VERIFIED never rests as a status — none may be reassigned.
      expect([...NEVER_ASSIGNABLE_JOB_STATUSES].sort()).toEqual(
        [JobStatusT.submitted, JobStatusT.verified, JobStatusT.archived, JobStatusT.voided].sort(),
      );
      for (const status of NEVER_ASSIGNABLE_JOB_STATUSES) {
        expect(ASSIGNABLE_JOB_STATUSES).not.toContain(status);
      }
    });

    it('partitions the lifecycle — every status is in exactly one of the two sets', () => {
      expect([...ASSIGNABLE_JOB_STATUSES, ...NEVER_ASSIGNABLE_JOB_STATUSES].sort()).toEqual(
        [...ALL_JOB_STATUSES].sort(),
      );
    });
  });

  describe('unassignedJobsForRuleWhere', () => {
    const rule = { assetDocumentId: 'doc-1', frequency: 'M3' as const };

    /**
     * THE RULE THE NON-CASCADING DEFAULT EXISTS TO PROTECT. A job that already
     * has somebody on it is never touched — this feature must not become a
     * back door to the silent reassignment the split was designed to prevent.
     */
    it('matches only jobs with NO assignee at all', () => {
      expect(unassignedJobsForRuleWhere(rule).assignedTo).toBeNull();
    });

    it('restricts to the states that may still legally be assigned', () => {
      expect(unassignedJobsForRuleWhere(rule).status).toEqual({
        in: [...ASSIGNABLE_JOB_STATUSES],
      });
    });

    /**
     * An ad-hoc job (UR-028) carries an empty `frequency_scope` and satisfies
     * no schedule period. It can share `(asset_document_id, frequency)` with a
     * rule by coincidence, but a standing assignee on a maintenance plan says
     * nothing about who should take a call-out.
     */
    it('excludes ad-hoc jobs', () => {
      expect(unassignedJobsForRuleWhere(rule).isAdhoc).toBe(false);
    });

    /**
     * `job` has no `schedule_rule_id`; generation copies these two columns off
     * the rule verbatim, and `schedule_rule` is
     * `@@unique([asset_document_id, frequency])`, so the pair names one rule.
     * Scoping by machine instead would sweep in the machine's OTHER documents
     * and other frequencies — "every job on the machine", which is not what a
     * planner was offered.
     */
    it('is keyed on the rule — this document and this frequency, across every due date', () => {
      const where = unassignedJobsForRuleWhere(rule);
      expect(where.assetDocumentId).toBe('doc-1');
      expect(where.frequency).toBe('M3');
      // Deliberately NOT keyed on `dueOn`: a plan whose visits were missed can
      // be carrying more than one live job, and all of them are unassigned.
      expect(where).not.toHaveProperty('dueOn');
      // And never on the asset — that would be every plan on the machine.
      expect(where).not.toHaveProperty('assetId');
    });
  });
});
