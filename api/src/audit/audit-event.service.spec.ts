import { AuditActionT } from '@prisma/client';
import { AuditEventService } from './audit-event.service';

describe('AuditEventService (PR-098 same-transaction audit writer)', () => {
  it('writes through the passed transaction client with a placeholder hash the trigger overwrites', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const tx = { auditEvent: { create } } as never;
    const service = new AuditEventService();

    await service.record(tx, {
      actorId: 'user-1',
      action: AuditActionT.create,
      entityType: 'asset',
      entityId: 'asset-1',
      before: null,
      after: { code: 'AW01' },
      requestId: 'req-1',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      actorId: 'user-1',
      action: AuditActionT.create,
      entityType: 'asset',
      entityId: 'asset-1',
      after: { code: 'AW01' },
      requestId: 'req-1',
    });
    expect(Buffer.isBuffer(arg.data.hash)).toBe(true);
    expect((arg.data.hash as Buffer).length).toBe(32);
  });
});
