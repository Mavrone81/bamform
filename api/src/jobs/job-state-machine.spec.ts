import { JobStatusT } from '@prisma/client';
import {
  ALL_JOB_STATUSES,
  ALL_TRANSITIONS,
  assertLegalTransition,
  isLegalTransition,
  type JobTransition,
} from './job-state-machine';

/** docs/TEST_PLAN.md §5.4 U-STM-01..03/05/06. U-STM-04 is `overdue.spec.ts` (slice 6, unchanged). */
describe('job-state-machine (PRD §5.1, U-STM-01..03)', () => {
  const EXPECTED_LEGAL: Record<JobStatusT, JobTransition[]> = {
    [JobStatusT.scheduled]: ['ASSIGN', 'VOID'],
    [JobStatusT.assigned]: ['START', 'VOID'],
    [JobStatusT.in_progress]: ['SUBMIT', 'VOID'],
    [JobStatusT.submitted]: ['VERIFY_ADVANCE', 'VERIFY_FINAL', 'RETURN', 'RECALL', 'VOID'],
    [JobStatusT.verified]: [],
    [JobStatusT.archived]: [],
    [JobStatusT.voided]: [],
  };

  it('U-STM-01: every legal transition is accepted', () => {
    for (const status of ALL_JOB_STATUSES) {
      for (const transition of EXPECTED_LEGAL[status]) {
        expect(isLegalTransition(status, transition)).toBe(true);
        expect(() => assertLegalTransition(status, transition)).not.toThrow();
      }
    }
  });

  it('U-STM-02: every illegal transition in the exhaustive matrix is rejected with invalid-transition', () => {
    let illegalCount = 0;
    for (const status of ALL_JOB_STATUSES) {
      for (const transition of ALL_TRANSITIONS) {
        if (EXPECTED_LEGAL[status].includes(transition)) {
          continue;
        }
        illegalCount += 1;
        expect(isLegalTransition(status, transition)).toBe(false);
        expect(() => assertLegalTransition(status, transition)).toThrow(
          expect.objectContaining({
            response: expect.objectContaining({ type: '/errors/invalid-transition' }),
          }),
        );
      }
    }
    // Sanity — a broken discovery (e.g. an empty ALL_TRANSITIONS) would
    // vacuously pass every assertion above.
    expect(illegalCount).toBeGreaterThan(30);
  });

  it('U-STM-03: no transition exists out of ARCHIVED, VERIFIED or VOIDED (terminal / never-resting states)', () => {
    for (const transition of ALL_TRANSITIONS) {
      expect(isLegalTransition(JobStatusT.archived, transition)).toBe(false);
      expect(isLegalTransition(JobStatusT.verified, transition)).toBe(false);
      expect(isLegalTransition(JobStatusT.voided, transition)).toBe(false);
    }
  });

  it('VERIFY_FINAL and VERIFY_ADVANCE are both only legal from SUBMITTED', () => {
    for (const status of ALL_JOB_STATUSES) {
      if (status === JobStatusT.submitted) continue;
      expect(isLegalTransition(status, 'VERIFY_ADVANCE')).toBe(false);
      expect(isLegalTransition(status, 'VERIFY_FINAL')).toBe(false);
    }
  });

  it('VOID is legal from every pre-terminal state (SCHEDULED, ASSIGNED, IN_PROGRESS, SUBMITTED)', () => {
    expect(isLegalTransition(JobStatusT.scheduled, 'VOID')).toBe(true);
    expect(isLegalTransition(JobStatusT.assigned, 'VOID')).toBe(true);
    expect(isLegalTransition(JobStatusT.in_progress, 'VOID')).toBe(true);
    expect(isLegalTransition(JobStatusT.submitted, 'VOID')).toBe(true);
  });
});
