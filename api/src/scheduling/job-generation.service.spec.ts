import { JobGenerationService } from './job-generation.service';

/**
 * Hand-rolled fake standing in for the exact PrismaService surface this
 * service touches. The integration suite (`test/integration/scheduling.spec.ts`)
 * already proves the real, end-to-end happy paths (I-INV-14/15, lead time,
 * active-item filtering, cascade_override) against a real Postgres — these
 * unit tests target the "no current revision" / "nothing to schedule" /
 * "unexpected DB error" branches that are awkward to provoke through real
 * fixtures but are one-line-easy to force through a fake.
 */
function makeRule(overrides: {
  frequency?: string;
  intervalMonths?: number;
  nextDueOn?: Date;
  leadTimeDays?: number;
} = {}) {
  return {
    id: 'rule-1',
    frequency: overrides.frequency ?? 'M6',
    intervalMonths: overrides.intervalMonths ?? 6,
    nextDueOn: overrides.nextDueOn ?? new Date('2020-01-01T00:00:00Z'), // long overdue
    active: true,
    asset: {
      id: 'asset-1',
      active: true,
      status: 'active',
      assetType: {
        formTemplateId: 'ft-1',
        approvalRouteId: 'route-1',
        leadTimeDays: overrides.leadTimeDays ?? 30,
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
  const revision = 'revision' in overrides ? overrides.revision : { id: 'rev-1', standingContent: {} };
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

function fakeAudit() {
  return { record: jest.fn(async () => undefined) };
}

describe('JobGenerationService — branches not reachable via a single real-Postgres fixture', () => {
  it('a due rule whose asset type has no CURRENT template revision is skipped, not errored', async () => {
    const prisma = fakePrisma({ revision: null });
    const service = new JobGenerationService(prisma as never, fakeAudit() as never);

    const result = await service.generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.evaluated).toBe(1);
    expect(result.generated).toBe(0);
    expect(result.alreadyExists).toBe(0);
    expect(result.skippedNoItems).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a due rule whose template has a current revision but zero active items in scope is skipped (U-CAS-05 at the wiring level)', async () => {
    const prisma = fakePrisma({ activeItems: [] });
    const service = new JobGenerationService(prisma as never, fakeAudit() as never);

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
    const service = new JobGenerationService(prisma as never, fakeAudit() as never);

    await expect(service.generateDueJobs(new Date('2026-07-24'), 30)).rejects.toThrow(
      /connection reset/,
    );
  });

  it('generates successfully and reports one evaluated/one generated when everything lines up', async () => {
    const prisma = fakePrisma({ activeItems: [{ frequency: 'M6' }] });
    const service = new JobGenerationService(prisma as never, fakeAudit() as never);

    const result = await service.generateDueJobs(new Date('2026-07-24'), 30);

    expect(result.evaluated).toBe(1);
    expect(result.generated).toBe(1);
    expect(result.skippedNoItems).toBe(0);
  });
});
