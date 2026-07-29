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
  /** Slice 27: bootstrap iterates a machine's DOCUMENTS, not the machine. */
  documents?: unknown[];
  revision?: unknown;
  activeItems?: Array<{ frequency: string }>;
  existingRules?: Array<{ frequency: string }>;
  createManyCount?: number;
}) {
  return {
    assetDocument: {
      findMany: jest.fn(async () => overrides.documents ?? []),
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

/**
 * One tagged document, with the machine it hangs off included the way
 * `ScheduleRuleBootstrapService` reads it.
 */
function oneDocument(id = 'doc-1', formTemplateId = 'ft-1') {
  return {
    id,
    formTemplateId,
    active: true,
    asset: {
      id: 'asset-1',
      active: true,
      status: 'active',
      // The anchor is a property of the MACHINE — several documents on one
      // machine share it.
      scheduleAnchorDate: new Date('2026-01-01T00:00:00Z'),
    },
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
  it('ensureForAsset is a no-op when the asset carries no active documents', async () => {
    const prisma = fakePrisma({ documents: [] });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('missing-asset');

    expect(prisma.templateRevision.findFirst).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ensureForAsset is a no-op when the DOCUMENT has no CURRENT template revision', async () => {
    const prisma = fakePrisma({
      documents: [oneDocument()],
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
      documents: [oneDocument()],
      revision: { id: 'rev-1' },
      activeItems: [],
    });
    const audit = fakeAudit();
    const service = new ScheduleRuleBootstrapService(prisma as never, audit as never);

    await service.ensureForAsset('asset-1');

    expect(prisma.scheduleRule.findMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ensureForAsset is a no-op when every candidate frequency already has a schedule_rule row for that document', async () => {
    const prisma = fakePrisma({
      documents: [oneDocument()],
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
      documents: [oneDocument()],
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
      documents: [oneDocument()],
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
      // Slice 27: keyed on the DOCUMENT — an asset-keyed audit row no longer
      // says WHICH of the machine's schedules was created.
      entityId: 'doc-1',
    });
  });

  /**
   * Slice 27-ASSETDOC. The per-document behaviour proper — the real-Postgres
   * version of these lives in `test/integration/cross-document-schedule.spec.ts`
   * (where the `(asset_document_id, frequency)` unique index actually exists);
   * these pin the service's own query shape, which a fake can see and a real DB
   * cannot distinguish from a lucky asset-scoped one.
   */
  describe('rules are created per DOCUMENT, not per machine', () => {
    it('creates a rule for EACH document on one machine at the same frequency', async () => {
      const prisma = fakePrisma({
        documents: [oneDocument('doc-A', 'ft-A'), oneDocument('doc-B', 'ft-B')],
        revision: { id: 'rev-1' },
        activeItems: [{ frequency: 'M1' }],
        existingRules: [],
        createManyCount: 1,
      });
      const service = new ScheduleRuleBootstrapService(prisma as never, fakeAudit() as never);

      await service.ensureForAsset('asset-1');

      // Two documents -> two independent createMany batches, each naming its
      // own document. Under the old (asset, frequency) key the second was a
      // duplicate and TE7's pH check could not be scheduled at all.
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      // Each document resolves its OWN current revision, from its own template.
      expect(prisma.templateRevision.findFirst).toHaveBeenNthCalledWith(1, {
        where: { formTemplateId: 'ft-A', status: 'current' },
      });
      expect(prisma.templateRevision.findFirst).toHaveBeenNthCalledWith(2, {
        where: { formTemplateId: 'ft-B', status: 'current' },
      });
      // Existing-rule lookups are document-scoped, so a sibling document's
      // 1M rule never masks this one as "already bootstrapped".
      expect(prisma.scheduleRule.findMany).toHaveBeenNthCalledWith(1, {
        where: { assetDocumentId: 'doc-A' },
        select: { frequency: true },
      });
      expect(prisma.scheduleRule.findMany).toHaveBeenNthCalledWith(2, {
        where: { assetDocumentId: 'doc-B' },
        select: { frequency: true },
      });
    });

    it('skips INACTIVE documents — the query never asks for them', async () => {
      const prisma = fakePrisma({ documents: [] });
      const service = new ScheduleRuleBootstrapService(prisma as never, fakeAudit() as never);

      await service.ensureForAsset('asset-1');

      // Deactivation (never deletion, INV-16) is how an admin retires a
      // document; a retired document must stop being scheduled.
      expect(prisma.assetDocument.findMany).toHaveBeenCalledWith({
        where: { assetId: 'asset-1', active: true },
        include: { asset: true },
      });
    });

    it('the plant-wide sweep skips inactive documents AND inactive machines', async () => {
      const prisma = fakePrisma({ documents: [] });
      const service = new ScheduleRuleBootstrapService(prisma as never, fakeAudit() as never);

      await service.ensureForAllActiveAssets();

      expect(prisma.assetDocument.findMany).toHaveBeenCalledWith({
        where: { active: true, asset: { active: true, status: 'active' } },
        include: { asset: true },
      });
    });
  });
});
