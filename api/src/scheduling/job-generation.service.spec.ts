import {
  DEFAULT_LEAD_TIME_DAYS,
  JobGenerationService,
  jobGenerationOpensOn,
  resolveDefaultLeadTimeDays,
} from './job-generation.service';

/**
 * Hand-rolled fake standing in for the exact PrismaService surface this
 * service touches. The integration suite (`test/integration/scheduling.spec.ts`)
 * already proves the real, end-to-end happy paths (I-INV-14/15, lead time,
 * active-item filtering, cascade_override) against a real Postgres — these
 * unit tests target the "no current revision" / "nothing to schedule" /
 * "unexpected DB error" branches that are awkward to provoke through real
 * fixtures but are one-line-easy to force through a fake.
 */
function makeRule(
  overrides: {
    frequency?: string;
    intervalMonths?: number;
    nextDueOn?: Date;
    leadTimeDays?: number;
    /** Slice 32-PLANNERJOB — the rule's STANDING assignee, if it has one. */
    defaultAssigneeId?: string | null;
  } = {},
) {
  return {
    id: 'rule-1',
    defaultAssigneeId: overrides.defaultAssigneeId ?? null,
    frequency: overrides.frequency ?? 'M6',
    intervalMonths: overrides.intervalMonths ?? 6,
    nextDueOn: overrides.nextDueOn ?? new Date('2020-01-01T00:00:00Z'), // long overdue
    active: true,
    // Slice 27-ASSETDOC: a rule reaches its machine THROUGH its document, and
    // the form template now hangs off the document rather than the asset type.
    assetDocument: {
      id: 'doc-1',
      formTemplateId: 'ft-1',
      active: true,
      asset: {
        id: 'asset-1',
        active: true,
        status: 'active',
        assetType: {
          // No `formTemplateId` — the approval route and lead time are all the
          // asset type still contributes.
          approvalRouteId: 'route-1',
          leadTimeDays: overrides.leadTimeDays ?? 30,
        },
      },
    },
  };
}

function fakePrisma(overrides: {
  rules?: ReturnType<typeof makeRule>[];
  // `null` (explicitly "no current revision") must be distinguishable from
  // "not provided" (use the default) — a `??` fallback would silently treat
  // an explicit `null` the same as `undefined` and mask the very branch this
  // fake exists to force, so presence is checked with `in` instead.
  revision?: unknown;
  activeItems?: Array<{ frequency: string }>;
  jobCreate?: () => Promise<{ id: string; dueOn: Date }>;
}) {
  const jobCreate =
    overrides.jobCreate ?? jest.fn(async () => ({ id: 'job-1', dueOn: new Date() }));
  const revision =
    'revision' in overrides ? overrides.revision : { id: 'rev-1', standingContent: {} };
  return {
    scheduleRule: {
      findMany: jest.fn(async () => overrides.rules ?? [makeRule()]),
    },
    templateRevision: {
      findFirst: jest.fn(async () => revision),
    },
    templateItem: {
      findMany: jest.fn(async () => overrides.activeItems ?? []),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb({
        job: {
          // nextJobNumber's MAX-scan (tx.job.findFirst): no prior jobs this year.
          findFirst: jest.fn(async () => null),
          create: jobCreate,
        },
        auditEvent: { create: jest.fn(async () => undefined) },
      });
    }),
  };
}

/**
 * `AuditEventService`'s surface, typed loosely enough that a test can read the
 * `after` payload back — slice 32-PLANNERJOB pins the permanent trace an
 * unavailable default assignee leaves in the job's own creation event.
 */
function fakeAudit() {
  return {
    record: jest.fn(async (_tx: unknown, _event: { after?: Record<string, unknown> }) => undefined),
  };
}

/** The `after` payload of the Nth `audit.record` call. */
function auditAfter(audit: ReturnType<typeof fakeAudit>, call = 0): Record<string, unknown> {
  return audit.record.mock.calls[call][1].after ?? {};
}

/**
 * Slice 32-PLANNERJOB — the two collaborators generation gained when a
 * `schedule_rule` learned to carry a STANDING assignee.
 *
 * `assignable` defaults to "everyone is eligible", which is inert for every
 * fixture above: `makeRule` names no `defaultAssigneeId`, so the check is
 * never consulted. The tests that DO care pass their own.
 */
function fakeAssignableUsers(verdict: 'assignable' | 'not-assignable' | 'unknown' = 'assignable') {
  return {
    checkAssignable: jest.fn(async () => ({
      verdict,
      detail: verdict === 'assignable' ? null : `stub ${verdict}`,
    })),
  };
}

function fakeNotifications() {
  return { enqueueNotification: jest.fn(async () => undefined) };
}

/** The service under test, with the fakes every construction site needs. */
function makeService(
  prisma: unknown,
  audit: unknown = fakeAudit(),
  assignable: unknown = fakeAssignableUsers(),
  notifications: unknown = fakeNotifications(),
) {
  return new JobGenerationService(
    prisma as never,
    audit as never,
    assignable as never,
    notifications as never,
  );
}

describe('JobGenerationService — branches not reachable via a single real-Postgres fixture', () => {
  it('a due rule whose DOCUMENT has no CURRENT template revision is skipped, not errored', async () => {
    const prisma = fakePrisma({ revision: null });
    const service = makeService(prisma);

    const result = await service.generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.evaluated).toBe(1);
    expect(result.generated).toBe(0);
    expect(result.alreadyExists).toBe(0);
    expect(result.skippedNoItems).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a due rule whose template has a current revision but zero active items in scope is skipped (U-CAS-05 at the wiring level)', async () => {
    const prisma = fakePrisma({ activeItems: [] });
    const service = makeService(prisma);

    const result = await service.generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.generated).toBe(0);
    expect(result.skippedNoItems).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an unexpected (non-P2002) DB error from job creation propagates instead of being swallowed as "already exists"', async () => {
    const jobCreate = jest.fn(async () => {
      throw new Error('connection reset — not a unique-constraint conflict');
    });
    const prisma = fakePrisma({
      activeItems: [{ frequency: 'M6' }],
      jobCreate,
    });
    const service = makeService(prisma);

    await expect(service.generateDueJobs(new Date('2026-07-24'), 30)).rejects.toThrow(
      /connection reset/,
    );
  });

  it('generates successfully and reports one evaluated/one generated when everything lines up', async () => {
    const prisma = fakePrisma({ activeItems: [{ frequency: 'M6' }] });
    const service = makeService(prisma);

    const result = await service.generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.evaluated).toBe(1);
    expect(result.generated).toBe(1);
    expect(result.skippedNoItems).toBe(0);
  });
});

/**
 * Slice 32-PLANNERJOB extracted the lead-time boundary so `GET /schedule` can
 * tell a planner WHEN a visit's job will be raised. These pin the two things
 * that would make that answer a lie: that the extracted function is the same
 * inequality `generateDueJobs` applies, and that a broken configured default
 * cannot silently widen the window.
 */
describe('the job-generation boundary, shared with GET /schedule', () => {
  describe('jobGenerationOpensOn', () => {
    it('is the due date less the lead time, as a whole UTC calendar day', () => {
      expect(jobGenerationOpensOn(new Date('2026-03-19T00:00:00Z'), 30)).toEqual(
        new Date('2026-02-17T00:00:00Z'),
      );
    });

    it('crosses a month and a year end without drifting', () => {
      expect(jobGenerationOpensOn(new Date('2026-01-10T00:00:00Z'), 30)).toEqual(
        new Date('2025-12-11T00:00:00Z'),
      );
    });

    it('strips any time-of-day, so a DATE column read back as a timestamp still lands on a day', () => {
      expect(jobGenerationOpensOn(new Date('2026-03-19T23:30:00Z'), 1)).toEqual(
        new Date('2026-03-18T00:00:00Z'),
      );
    });

    /**
     * The equivalence the extraction rests on. `generateDueJobs` skips while
     * `nextDueOn > today + lead`; this says the job opens at
     * `nextDueOn - lead`. If those two ever stop being the same inequality,
     * the planner would promise a date the scheduler does not honour.
     */
    it('is exactly the boundary generateDueJobs tests — proven either side of it', async () => {
      const nextDueOn = new Date('2026-03-19T00:00:00Z');
      const opensOn = jobGenerationOpensOn(nextDueOn, 30);
      const dayBefore = new Date(opensOn.getTime() - 24 * 60 * 60 * 1000);

      const onTheDay = fakePrisma({
        rules: [makeRule({ nextDueOn })],
        activeItems: [{ frequency: 'M6' }],
      });
      const early = fakePrisma({
        rules: [makeRule({ nextDueOn })],
        activeItems: [{ frequency: 'M6' }],
      });

      expect(
        (await makeService(onTheDay).generateDueJobs(opensOn, DEFAULT_LEAD_TIME_DAYS)).generated,
      ).toBe(1);
      expect(
        (await makeService(early).generateDueJobs(dayBefore, DEFAULT_LEAD_TIME_DAYS)).evaluated,
      ).toBe(0);
    });
  });

  describe('resolveDefaultLeadTimeDays', () => {
    it('takes a configured value', () => {
      expect(resolveDefaultLeadTimeDays('45')).toBe(45);
      expect(resolveDefaultLeadTimeDays(45)).toBe(45);
    });

    it('falls back to the documented default when nothing is configured', () => {
      expect(resolveDefaultLeadTimeDays(undefined)).toBe(DEFAULT_LEAD_TIME_DAYS);
      expect(resolveDefaultLeadTimeDays(null)).toBe(DEFAULT_LEAD_TIME_DAYS);
    });

    /**
     * The reason this function exists rather than a bare `Number(x ?? 30)`.
     * `Number('thirty')` is `NaN`, and `nextDueOn > today + NaN` is FALSE for
     * every rule in the plant — so a typo in the environment would not have
     * failed, it would have generated the entire remaining schedule in one
     * sweep.
     */
    it('refuses a value that would make the window meaningless', () => {
      expect(resolveDefaultLeadTimeDays('thirty')).toBe(DEFAULT_LEAD_TIME_DAYS);
      expect(resolveDefaultLeadTimeDays('')).toBe(DEFAULT_LEAD_TIME_DAYS);
      expect(resolveDefaultLeadTimeDays(0)).toBe(DEFAULT_LEAD_TIME_DAYS);
      expect(resolveDefaultLeadTimeDays(-5)).toBe(DEFAULT_LEAD_TIME_DAYS);
      expect(resolveDefaultLeadTimeDays(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LEAD_TIME_DAYS);
    });
  });
});

/**
 * Slice 32-PLANNERJOB — a `schedule_rule` can name WHO NORMALLY DOES THIS PM,
 * and generation applies it.
 *
 * This is the half that decides whether ~220 planned visits a year arrive with
 * somebody on them or arrive invisible: a MAINTAINER only ever sees jobs
 * assigned to them (`job-access.ts`), so an unassigned job is, to the person
 * who should do it, indistinguishable from no job at all.
 *
 * The interesting case is the LAPSED default — a technician who left, a role
 * revoked, an area scope narrowed. The decision is generate-unassigned rather
 * than refuse (the job IS the controlled record, and a plant that stops
 * raising PM records has an audit finding), and these pin that it is never
 * SILENT: a counter, an error log, and a permanent flag in the job's own
 * creation audit event.
 */
describe('the standing assignee on a schedule rule', () => {
  function jobCreateSpy() {
    return jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'job-1',
      jobNumber: 'PM-2026-000001',
      dueOn: new Date(),
      ...args.data,
    }));
  }

  it('generates the job ALREADY ASSIGNED when the default is still eligible', async () => {
    const jobCreate = jobCreateSpy();
    const prisma = fakePrisma({
      rules: [makeRule({ defaultAssigneeId: 'tech-1' })],
      activeItems: [{ frequency: 'M6' }],
      jobCreate: jobCreate as never,
    });
    const notifications = fakeNotifications();
    const result = await makeService(
      prisma,
      fakeAudit(),
      fakeAssignableUsers('assignable'),
      notifications,
    ).generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.generated).toBe(1);
    expect(result.assignedFromDefault).toBe(1);
    expect(result.defaultAssigneeUnavailable).toBe(0);

    const data = jobCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.assignedTo).toBe('tech-1');
    // The PRD §5.1 edge a manual assignment takes, taken at birth instead.
    expect(data.status).toBe('assigned');
    expect(data.assignedAt).toBeInstanceOf(Date);

    // UR-061 — the assignee has to LEARN they have work, exactly as a manual
    // assignment tells them. Without this the job is assigned and unannounced.
    expect(notifications.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'tech-1', templateCode: 'JOB_ASSIGNED' }),
    );
  });

  it('leaves a rule with NO default exactly as it was before this slice', async () => {
    const jobCreate = jobCreateSpy();
    const prisma = fakePrisma({
      activeItems: [{ frequency: 'M6' }],
      jobCreate: jobCreate as never,
    });
    const notifications = fakeNotifications();
    const result = await makeService(
      prisma,
      fakeAudit(),
      fakeAssignableUsers('assignable'),
      notifications,
    ).generateDueJobs(new Date('2026-07-24'), 30);

    const data = jobCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.assignedTo).toBeNull();
    expect(data.assignedAt).toBeNull();
    expect(data.status).toBe('scheduled');
    expect(result.assignedFromDefault).toBe(0);
    // Nobody to notify, so nothing is sent — not an empty notification.
    expect(notifications.enqueueNotification).not.toHaveBeenCalled();
  });

  describe('when the default assignee is no longer eligible', () => {
    async function runLapsed() {
      const jobCreate = jobCreateSpy();
      const audit = fakeAudit();
      const notifications = fakeNotifications();
      const prisma = fakePrisma({
        rules: [makeRule({ defaultAssigneeId: 'tech-gone' })],
        activeItems: [{ frequency: 'M6' }],
        jobCreate: jobCreate as never,
      });
      const result = await makeService(
        prisma,
        audit,
        fakeAssignableUsers('not-assignable'),
        notifications,
      ).generateDueJobs(new Date('2026-07-24'), 30);
      return { result, jobCreate, audit, notifications };
    }

    /**
     * THE DECISION. Refusing would stall the schedule for ever —
     * `next_due_on` only advances on completion, so a job that is never
     * raised is a rule that is never cleared — and would stop the plant
     * producing the very records the ISO audit asks for.
     */
    it('still generates the job, unassigned, rather than refusing', async () => {
      const { result, jobCreate } = await runLapsed();
      expect(result.generated).toBe(1);
      const data = jobCreate.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.assignedTo).toBeNull();
      expect(data.status).toBe('scheduled');
    });

    it('counts it, so the sweep’s own log line names it', async () => {
      const { result } = await runLapsed();
      expect(result.defaultAssigneeUnavailable).toBe(1);
      expect(result.assignedFromDefault).toBe(0);
    });

    /**
     * The trace that OUTLIVES log rotation. Without it, a job that quietly
     * arrived unassigned is indistinguishable from a rule that never had a
     * default — and "the work stopped being assigned" would look exactly like
     * "there was no work".
     */
    it('records WHY in the job’s own creation audit event, by id', async () => {
      const { audit } = await runLapsed();
      const after = auditAfter(audit);
      expect(after.defaultAssigneeUnavailable).toBe(true);
      expect(after.defaultAssigneeId).toBe('tech-gone');
      expect(after.assignedTo).toBeNull();
    });

    it('does not notify anybody — there is nobody to notify', async () => {
      const { notifications } = await runLapsed();
      expect(notifications.enqueueNotification).not.toHaveBeenCalled();
    });

    it('says nothing about an unavailable default on a rule that has none', async () => {
      const audit = fakeAudit();
      const prisma = fakePrisma({ activeItems: [{ frequency: 'M6' }] });
      await makeService(prisma, audit, fakeAssignableUsers('not-assignable')).generateDueJobs(
        new Date('2026-07-24'),
        30,
      );
      const after = auditAfter(audit);
      // The flag is present ONLY when a default was named and rejected, so its
      // presence in the audit chain is itself the signal.
      expect(after).not.toHaveProperty('defaultAssigneeUnavailable');
    });
  });

  /**
   * A notification failure must never un-generate a job that is already the
   * controlled record — the same stance `AssignmentService` takes.
   */
  it('keeps the generated job when the notification enqueue fails', async () => {
    const notifications = {
      enqueueNotification: jest.fn(async () => {
        throw new Error('redis unreachable');
      }),
    };
    const prisma = fakePrisma({
      rules: [makeRule({ defaultAssigneeId: 'tech-1' })],
      activeItems: [{ frequency: 'M6' }],
    });
    const result = await makeService(
      prisma,
      fakeAudit(),
      fakeAssignableUsers('assignable'),
      notifications,
    ).generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.generated).toBe(1);
    expect(result.assignedFromDefault).toBe(1);
  });
});

/**
 * REVIEW FINDING — "could not tell" is not "not eligible".
 *
 * The eligibility check reads three tables. When one of those reads fails, the
 * old boolean had nowhere to put the failure and returned `false`, so a
 * dropped connection was recorded — in the append-only, hash-chained audit
 * event, permanently — as "this named person is no longer eligible", and the
 * log told the planner to go and fix a role grant that was never broken.
 *
 * These pin the distinction at the one place where the consequence is
 * permanent.
 */
describe('when the eligibility check cannot be completed', () => {
  function jobCreateSpy() {
    return jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'job-1',
      jobNumber: 'PM-2026-000001',
      dueOn: new Date(),
      ...args.data,
    }));
  }

  async function sweepWithIndeterminateCheck() {
    const jobCreate = jobCreateSpy();
    const audit = fakeAudit();
    const notifications = fakeNotifications();
    const prisma = fakePrisma({
      rules: [makeRule({ defaultAssigneeId: 'tech-1' })],
      activeItems: [{ frequency: 'M6' }],
      jobCreate: jobCreate as never,
    });
    const result = await makeService(
      prisma,
      audit,
      fakeAssignableUsers('unknown'),
      notifications,
    ).generateDueJobs(new Date('2026-07-24'), 30);
    return { result, jobCreate, audit, notifications };
  }

  /**
   * Generate rather than stall: `next_due_on` only advances on completion, so
   * refusing over a transient blip would leave the rule overdue for ever. And
   * generate UNASSIGNED rather than assigning anyway — handing controlled work
   * to someone who may genuinely have left, with nothing having checked, is
   * the worse error.
   */
  it('still generates the job, unassigned', async () => {
    const { result, jobCreate } = await sweepWithIndeterminateCheck();
    expect(result.generated).toBe(1);
    const data = jobCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.assignedTo).toBeNull();
    expect(data.status).toBe('scheduled');
  });

  it('counts it apart from a genuine ineligibility — the two need different responses', async () => {
    const { result } = await sweepWithIndeterminateCheck();
    expect(result.defaultAssigneeIndeterminate).toBe(1);
    // NOT this one. That counter means "the plan is wrong, name someone else";
    // this situation means "look at the database".
    expect(result.defaultAssigneeUnavailable).toBe(0);
    expect(result.assignedFromDefault).toBe(0);
  });

  /**
   * THE POINT OF THE WHOLE FIX. `defaultAssigneeUnavailable: true` is a claim
   * about a named human, it is unfalsifiable once chained, and it is kept for
   * seven years. It must never be written on the strength of a failed lookup.
   */
  it('records a CHECK failure in the audit event, never a finding about the person', async () => {
    const { audit } = await sweepWithIndeterminateCheck();
    const after = auditAfter(audit);

    expect(after.defaultAssigneeCheckFailed).toBe(true);
    expect(after).not.toHaveProperty('defaultAssigneeUnavailable');
    // The id is still recorded — an operator needs to know which assignment
    // could not be verified — but nothing is asserted about them.
    expect(after.defaultAssigneeId).toBe('tech-1');
    expect(after.assignedTo).toBeNull();
  });

  it('notifies nobody — there is nobody it could honestly notify', async () => {
    const { notifications } = await sweepWithIndeterminateCheck();
    expect(notifications.enqueueNotification).not.toHaveBeenCalled();
  });

  /**
   * The sweep runs unattended over every rule in the plant. `checkAssignable`
   * is contractually non-throwing, but this pins the consequence at the
   * generation layer too: one unresolvable rule must not abort the run and
   * leave the rest of the plant's PM unraised.
   */
  it('does not abort the sweep — later rules still generate', async () => {
    const jobCreate = jobCreateSpy();
    const prisma = fakePrisma({
      rules: [makeRule({ defaultAssigneeId: 'tech-1' }), { ...makeRule(), id: 'rule-2' }],
      activeItems: [{ frequency: 'M6' }],
      jobCreate: jobCreate as never,
    });
    const result = await makeService(
      prisma,
      fakeAudit(),
      fakeAssignableUsers('unknown'),
    ).generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.evaluated).toBe(2);
    expect(result.generated).toBe(2);
    expect(result.defaultAssigneeIndeterminate).toBe(1);
  });

  /**
   * And the mirror: an ESTABLISHED refusal must still be recorded as one. The
   * fix must not have made every failure indeterminate, which would be the
   * same defect pointing the other way — a technician who really did leave,
   * reported for ever as "we could not check".
   */
  it('leaves the established-ineligible path recording a real finding', async () => {
    const audit = fakeAudit();
    const prisma = fakePrisma({
      rules: [makeRule({ defaultAssigneeId: 'tech-gone' })],
      activeItems: [{ frequency: 'M6' }],
    });
    const result = await makeService(
      prisma,
      audit,
      fakeAssignableUsers('not-assignable'),
    ).generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.defaultAssigneeUnavailable).toBe(1);
    expect(result.defaultAssigneeIndeterminate).toBe(0);
    const after = auditAfter(audit);
    expect(after.defaultAssigneeUnavailable).toBe(true);
    expect(after).not.toHaveProperty('defaultAssigneeCheckFailed');
  });
});
