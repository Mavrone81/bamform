import { AuditActionT } from '@prisma/client';
import { CompletionCascadeService } from './completion-cascade.service';
import { addCalendarMonthsClamped } from './completion-cascade';
import type { RecordAuditEventParams } from '../audit/audit-event.service';

interface UpdateManyArgs {
  where: { assetDocumentId: string; frequency: string };
  data: { lastCompletedOn: Date; nextDueOn: Date };
}

/** Minimal fake standing in for the one `tx.scheduleRule` surface this service uses. */
function fakeTx(updateManyCounts: number[]) {
  let call = 0;
  return {
    scheduleRule: {
      updateMany: jest.fn(async (_args: UpdateManyArgs): Promise<{ count: number }> => {
        return { count: updateManyCounts[call++] ?? 1 };
      }),
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

describe('CompletionCascadeService.apply (PR-055/PR-056 — the DB-write seam slice 7 will call)', () => {
  it('updates every subsumed schedule_rule and records one audit event per row actually updated', async () => {
    const audit = fakeAudit();
    const service = new CompletionCascadeService(audit as never);
    const tx = fakeTx([1, 1, 1, 1]);
    const verifiedOn = new Date('2026-07-24T00:00:00Z');

    await service.apply(tx as never, {
      jobId: 'job-1',
      assetDocumentId: 'doc-1',
      assetId: 'asset-1',
      frequencyScope: ['M1', 'M3', 'M6', 'Y'],
      verifiedOn,
      actorId: 'user-1',
    });

    expect(tx.scheduleRule.updateMany).toHaveBeenCalledTimes(4);
    expect(tx.scheduleRule.updateMany).toHaveBeenNthCalledWith(1, {
      where: { assetDocumentId: 'doc-1', frequency: 'M1' },
      data: {
        lastCompletedOn: verifiedOn,
        nextDueOn: addCalendarMonthsClamped(verifiedOn, 1),
      },
    });
    expect(tx.scheduleRule.updateMany).toHaveBeenNthCalledWith(4, {
      where: { assetDocumentId: 'doc-1', frequency: 'Y' },
      data: {
        lastCompletedOn: verifiedOn,
        nextDueOn: addCalendarMonthsClamped(verifiedOn, 12),
      },
    });
    // (the pure date-math itself is exercised exhaustively by completion-cascade.spec.ts's
    // U-SCH-01..04 — here we only need to prove the SERVICE wires tx/audit calls correctly)
    expect(audit.record).toHaveBeenCalledTimes(4);
    for (const call of audit.record.mock.calls) {
      const [txArg, params] = call;
      expect(txArg).toBe(tx);
      expect(params).toMatchObject({
        actorId: 'user-1',
        action: AuditActionT.update,
        entityType: 'schedule_rule',
        entityId: 'doc-1',
      });
      expect((params.after as { causedByJobId: string }).causedByJobId).toBe('job-1');
    }
  });

  it('U-SCH-02-at-the-service-level: a 3M job only cascades to the frequencies frozen into its own scope (1M, 3M) — 6M/Y are never touched because they are never in tx calls', async () => {
    const audit = fakeAudit();
    const service = new CompletionCascadeService(audit as never);
    const tx = fakeTx([1, 1]);

    await service.apply(tx as never, {
      jobId: 'job-2',
      assetDocumentId: 'doc-2',
      assetId: 'asset-2',
      frequencyScope: ['M1', 'M3'],
      verifiedOn: new Date('2026-07-24T00:00:00Z'),
      actorId: null,
    });

    expect(tx.scheduleRule.updateMany).toHaveBeenCalledTimes(2);
    const frequenciesTouched = tx.scheduleRule.updateMany.mock.calls.map(
      (call) => call[0].where.frequency,
    );
    expect(frequenciesTouched).toEqual(['M1', 'M3']);
    expect(frequenciesTouched).not.toContain('M6');
    expect(frequenciesTouched).not.toContain('Y');
  });

  it('when updateMany matches zero rows (schedule_rule already gone/inactive), no audit event is recorded for that frequency', async () => {
    const audit = fakeAudit();
    const service = new CompletionCascadeService(audit as never);
    // First frequency (M1) has no matching schedule_rule row (count: 0); second (M6) does.
    const tx = fakeTx([0, 1]);

    await service.apply(tx as never, {
      jobId: 'job-3',
      assetDocumentId: 'doc-3',
      assetId: 'asset-3',
      frequencyScope: ['M1', 'M6'],
      verifiedOn: new Date('2026-07-24T00:00:00Z'),
      actorId: 'user-1',
    });

    expect(tx.scheduleRule.updateMany).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({ entityId: 'doc-3' });
    const [, onlyCallParams] = audit.record.mock.calls[0];
    expect((onlyCallParams.after as { frequency: string }).frequency).toBe('M6');
  });

  it('an empty frequency_scope updates nothing and records no audit event', async () => {
    const audit = fakeAudit();
    const service = new CompletionCascadeService(audit as never);
    const tx = fakeTx([]);

    await service.apply(tx as never, {
      jobId: 'job-4',
      assetDocumentId: 'doc-4',
      assetId: 'asset-4',
      frequencyScope: [],
      verifiedOn: new Date('2026-07-24T00:00:00Z'),
      actorId: null,
    });

    expect(tx.scheduleRule.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
