import { JobStatusT } from '@prisma/client';
import { isOverdue } from './overdue';

/**
 * PR-043 / BUILD_HANDOFF non-negotiable #12: "Overdue is derived, never
 * stored." This is the single place that derivation happens — no `overdue`
 * column exists anywhere in the schema (DBD §6.15).
 */
describe('isOverdue (PR-043, non-negotiable #12)', () => {
  const today = new Date('2026-07-25T00:00:00.000Z');

  it('true when due_on is in the past and the job is still open', () => {
    expect(isOverdue(new Date('2026-07-01'), JobStatusT.assigned, today)).toBe(true);
    expect(isOverdue(new Date('2026-07-01'), JobStatusT.in_progress, today)).toBe(true);
    expect(isOverdue(new Date('2026-07-01'), JobStatusT.scheduled, today)).toBe(true);
    expect(isOverdue(new Date('2026-07-01'), JobStatusT.submitted, today)).toBe(true);
  });

  it('false when due_on is today or in the future', () => {
    expect(isOverdue(today, JobStatusT.assigned, today)).toBe(false);
    expect(isOverdue(new Date('2026-08-01'), JobStatusT.assigned, today)).toBe(false);
  });

  it.each([JobStatusT.verified, JobStatusT.archived, JobStatusT.voided])(
    'false once the job has reached a terminal status (%s), even if due_on is in the past',
    (status) => {
      expect(isOverdue(new Date('2026-01-01'), status, today)).toBe(false);
    },
  );
});
