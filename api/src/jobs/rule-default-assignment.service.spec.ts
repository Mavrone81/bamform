import { ConflictException, InternalServerErrorException, Logger } from '@nestjs/common';
import type { ActorMeta } from '../common/actor-meta';
import { invalidTransitionProblem, validationFailedProblem } from '../common/domain-problems';
import type { PlannerScheduleService } from '../scheduling/planner-schedule.service';
import type { AssignmentService } from './assignment.service';
import { RuleDefaultAssignmentService } from './rule-default-assignment.service';
import { MAX_APPLY_DEFAULT_BATCH } from './rule-unassigned-jobs';

/**
 * Slice 33-APPLYDEFAULT — THE BATCH'S OWN BEHAVIOUR, with the two collaborators
 * stubbed.
 *
 * WHY THESE PROPERTIES ARE PROVED HERE RATHER THAN IN INTEGRATION. Everything
 * about WHICH jobs are selected, and that they are really assigned, audited and
 * notified, is proved end to end against real Postgres in
 * `test/integration/schedule-apply-default-assignee.spec.ts` — that is where it
 * belongs, because those are claims about the database and the real
 * `AssignmentService`.
 *
 * What CANNOT be produced there is a mixed batch: every job on one rule sits on
 * one machine, so there is no honest fixture in which the real assign service
 * accepts one job and refuses the next. Constructing one would mean writing
 * inconsistent rows (a job whose `asset_id` and `asset_document_id` disagree)
 * and then asserting on the behaviour of data that cannot exist. So the
 * orchestration — one refusal does not abort the batch, does not roll back what
 * already committed, and is reported by job number with the server's own words
 * — is proved here, where a refusal can be injected precisely.
 */
describe('RuleDefaultAssignmentService — applying a standing assignee to jobs already raised', () => {
  const ACTOR: ActorMeta = { actorId: 'planner-1', sourceIp: '10.0.0.1', requestId: 'req-1' };
  const ROLES = ['PLANNER'];
  const ASSIGNEE = 'tech-1';

  // The unexpected-failure case deliberately logs at error level; the log is
  // the point (a fault must be traceable), the console noise is not.
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });

  interface StubJob {
    id: string;
    jobNumber: string;
  }

  function build(options: {
    defaultAssigneeId?: string | null;
    jobs?: StubJob[];
    assign?: jest.Mock;
  }) {
    const jobs = options.jobs ?? [
      { id: 'job-a', jobNumber: 'PM-2026-000001' },
      { id: 'job-b', jobNumber: 'PM-2026-000002' },
      { id: 'job-c', jobNumber: 'PM-2026-000003' },
    ];
    const findRuleWithUnassignedJobs = jest.fn().mockResolvedValue({
      rule: {
        id: 'rule-1',
        assetDocumentId: 'doc-1',
        frequency: 'M3',
        defaultAssigneeId:
          options.defaultAssigneeId === undefined ? ASSIGNEE : options.defaultAssigneeId,
      },
      jobs,
    });
    const assign = options.assign ?? jest.fn().mockResolvedValue({ id: 'ignored' });
    const service = new RuleDefaultAssignmentService(
      { findRuleWithUnassignedJobs } as unknown as PlannerScheduleService,
      { assign } as unknown as AssignmentService,
    );
    return { service, assign, findRuleWithUnassignedJobs, jobs };
  }

  it('assigns every candidate through the real single-job service, one call per job', async () => {
    const { service, assign } = build({});

    const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
      assigneeId: ASSIGNEE,
    });

    expect(assign).toHaveBeenCalledTimes(3);
    // The exact signature `POST /jobs/{jobId}/assign` uses — same dto, same
    // actor, same roles. Nothing here bulk-UPDATEs `assigned_to`, because a
    // column write would produce assigned jobs with no audit event and no
    // JOB_ASSIGNED notification.
    expect(assign).toHaveBeenNthCalledWith(
      1,
      'job-a',
      { assigneeId: ASSIGNEE },
      undefined,
      ACTOR,
      ROLES,
    );
    expect(result.assigned.map((entry) => entry.jobNumber)).toEqual([
      'PM-2026-000001',
      'PM-2026-000002',
      'PM-2026-000003',
    ]);
    expect(result.refused).toEqual([]);
    expect(result.notAttempted).toBe(0);
    expect(result.assigneeId).toBe(ASSIGNEE);
  });

  describe('partial failure', () => {
    /**
     * THE PROPERTY THAT MATTERS MOST. A batch that gave up on the first
     * refusal would leave a planner with some jobs assigned, some not, and no
     * statement of which — the silent half-application this whole feature
     * exists to replace.
     */
    it('does not abort: a refusal in the middle still lets the rest through', async () => {
      const assign = jest.fn().mockImplementation((jobId: string) => {
        if (jobId === 'job-b') {
          return Promise.reject(
            invalidTransitionProblem('Job is SUBMITTED — ASSIGN is not a legal transition.'),
          );
        }
        return Promise.resolve({ id: jobId });
      });
      const { service } = build({ assign });

      const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
        assigneeId: ASSIGNEE,
      });

      expect(assign).toHaveBeenCalledTimes(3);
      expect(result.assigned.map((entry) => entry.jobId)).toEqual(['job-a', 'job-c']);
      expect(result.refused).toEqual([
        {
          jobId: 'job-b',
          jobNumber: 'PM-2026-000002',
          // The server's own words, verbatim — a planner told "2 of 3" and
          // nothing else has no way to find the third.
          reason: 'Job is SUBMITTED — ASSIGN is not a legal transition.',
        },
      ]);
    });

    it('reports the refusal for the job it actually happened to, by number', async () => {
      const assign = jest
        .fn()
        .mockImplementation((jobId: string) =>
          jobId === 'job-c'
            ? Promise.reject(
                validationFailedProblem('That person cannot be assigned to this machine.'),
              )
            : Promise.resolve({ id: jobId }),
        );
      const { service } = build({ assign });

      const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
        assigneeId: ASSIGNEE,
      });

      expect(result.refused).toHaveLength(1);
      expect(result.refused[0].jobNumber).toBe('PM-2026-000003');
      expect(result.refused[0].reason).toContain('cannot be assigned');
      expect(result.assigned).toHaveLength(2);
    });

    it('never reports success for a job it could not assign', async () => {
      const assign = jest
        .fn()
        .mockRejectedValue(validationFailedProblem('Nobody may be assigned here.'));
      const { service } = build({ assign });

      const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
        assigneeId: ASSIGNEE,
      });

      expect(result.assigned).toEqual([]);
      expect(result.refused).toHaveLength(3);
    });

    /**
     * A FAULT IS NOT A REFUSAL. An unexpected error must not be dressed up as
     * "this job was ineligible" — that is a claim about the job the server has
     * not established — but it also must not abort the batch.
     */
    it('survives a non-problem failure without claiming the job was ineligible', async () => {
      const assign = jest.fn().mockImplementation((jobId: string) => {
        if (jobId === 'job-a') return Promise.reject(new Error('connection reset'));
        return Promise.resolve({ id: jobId });
      });
      const { service } = build({ assign });

      const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
        assigneeId: ASSIGNEE,
      });

      expect(result.assigned).toHaveLength(2);
      expect(result.refused[0].reason).toContain('the server failed while applying it');
      expect(result.refused[0].reason).not.toContain('connection reset');
    });

    it('carries an HttpException with no `detail` through as its message', async () => {
      const assign = jest.fn().mockRejectedValue(new InternalServerErrorException('upstream gone'));
      const { service } = build({ assign, jobs: [{ id: 'job-a', jobNumber: 'PM-1' }] });

      const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
        assigneeId: ASSIGNEE,
      });

      expect(result.refused[0].reason).toBe('upstream gone');
    });
  });

  describe('the assignee is re-checked against the plan', () => {
    /**
     * The planner answered a question about a NAMED person. If somebody else
     * changed the plan between the offer and the answer, applying whatever the
     * column now holds would assign real work to a person the planner never
     * saw named.
     */
    it('refuses with 409 and assigns NOTHING when the standing assignee changed', async () => {
      const { service, assign } = build({ defaultAssigneeId: 'somebody-else' });

      await expect(
        service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', { assigneeId: ASSIGNEE }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(assign).not.toHaveBeenCalled();
    });

    it('refuses when the plan has no standing assignee at all', async () => {
      const { service, assign } = build({ defaultAssigneeId: null });

      await expect(
        service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', { assigneeId: ASSIGNEE }),
      ).rejects.toMatchObject({ status: 422 });
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('the batch cap', () => {
    it('asks for one more than the cap so it can tell "more" from "exactly"', async () => {
      const { service, findRuleWithUnassignedJobs } = build({});

      await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', { assigneeId: ASSIGNEE });

      expect(findRuleWithUnassignedJobs).toHaveBeenCalledWith(
        'planner-1',
        'rule-1',
        MAX_APPLY_DEFAULT_BATCH + 1,
      );
    });

    it('reports what it did not attempt rather than letting a partial read as complete', async () => {
      const jobs = Array.from({ length: MAX_APPLY_DEFAULT_BATCH + 1 }, (_, index) => ({
        id: `job-${index}`,
        jobNumber: `PM-${index}`,
      }));
      const { service, assign } = build({ jobs });

      const result = await service.applyToExistingJobs(ACTOR, ROLES, 'rule-1', {
        assigneeId: ASSIGNEE,
      });

      expect(assign).toHaveBeenCalledTimes(MAX_APPLY_DEFAULT_BATCH);
      expect(result.assigned).toHaveLength(MAX_APPLY_DEFAULT_BATCH);
      expect(result.notAttempted).toBe(1);
    });
  });
});
