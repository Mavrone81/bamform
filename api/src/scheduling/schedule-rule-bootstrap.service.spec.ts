import { AuditActionT } from '@prisma/client';
import { ScheduleRuleBootstrapService } from './schedule-rule-bootstrap.service';
import type { RecordAuditEventParams } from '../audit/audit-event.service';

/**
 * Hand-rolled fake standing in for the exact PrismaService surface this
 * service touches — mirrors the `scheduler-lock.service.spec.ts` pattern
 * (fake the one dependency's shape rather than spin up real Postgres) for
 * the no-op / edge-case branches that are awkward to hit through the
 * integration suite (which already covers the happy path end-to-end).
 */
function fakePrisma(overrides: {
  asset?: unknown;
  revision?: unknown;
  activeItems?: Array<{ frequency: string }>;
  existingRules?: Array<{ frequency: string }>;
  createManyCount?: number;
}) {
  return {
    asset: {
      findUnique: jest.fn(async () => overrides.asset ?? null),
    },
    templateRevision: {
      findFirst: jest.fn(async () => overrides.revision ?? null),
    },
    templateItem: {
      findMany: jest.fn(async () => overrides.activeItems ?? []),
    },
    scheduleRule: {
      findMany: jest.fn(async () => overrides.existingRules ?? []),
      createMany: jest.fn(async () => ({ count: overrides.createManyCount ?? 0 })),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb({
        scheduleRule: {
          createMany: jest.fn(async () => ({ count: overrides.createManyCount ?? 0 })),
        },
      });
    }),
  };
}

function fakeAudit() {
  return {
    record: jest.fn(async (_tx: unknown, _params: RecordAuditEventParams): Promise<void> => {
      return undefined;
    }),
  };
}

describe('ScheduleRuleBootstrapService (self-heal edge cases not covered end-to-end)', () => {
  it('ensureForAsset is a no-op when the asset does not exist', async () => {
    const prisma = fakePrisma({ asset: null });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('missing-asset');

    expect(prisma.templateRevision.findFirst).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ensureForAsset is a no-op when the asset type has no CURRENT template revision', async () => {
    const prisma = fakePrisma({
      asset: { id: 'asset-1', assetType: { formTemplateId: 'ft-1' } },
      revision: null,
    });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('asset-1');

    expect(prisma.templateItem.findMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ensureForAsset is a no-op when the current revision has zero active items', async () => {
    const prisma = fakePrisma({
      asset: { id: 'asset-1', assetType: { formTemplateId: 'ft-1' } },
      revision: { id: 'rev-1' },
      activeItems: [],
    });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('asset-1');

    expect(prisma.scheduleRule.findMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ensureForAsset is a no-op when every candidate frequency already has a schedule_rule row', async () => {
    const prisma = fakePrisma({
      asset: { id: 'asset-1', assetType: { formTemplateId: 'ft-1' } },
      revision: { id: 'rev-1' },
      activeItems: [{ frequency: 'M1' }],
      existingRules: [{ frequency: 'M1' }],
    });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('asset-1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not record an audit event when createMany inserts zero rows (all skipped as duplicates)', async () => {
    const prisma = fakePrisma({
      asset: { id: 'asset-1', assetType: { formTemplateId: 'ft-1' } },
      revision: { id: 'rev-1' },
      activeItems: [{ frequency: 'M1' }],
      existingRules: [], // missing.length > 0 so $transaction runs...
      createManyCount: 0, // ...but createMany itself reports 0 inserted (race with a concurrent bootstrap)
    });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('asset-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records an audit event when createMany actually inserts rows', async () => {
    const prisma = fakePrisma({
      asset: { id: 'asset-1', assetType: { formTemplateId: 'ft-1' } },
      revision: { id: 'rev-1' },
      activeItems: [{ frequency: 'M1' }],
      existingRules: [],
      createManyCount: 1,
    });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('asset-1');

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: AuditActionT.create,
      entityType: 'schedule_rule',
      entityId: 'asset-1',
    });
  });
});
