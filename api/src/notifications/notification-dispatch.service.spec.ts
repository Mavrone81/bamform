import { NotificationDispatchService } from './notification-dispatch.service';
import type { NotificationTransport } from './transports/notification-transport';

/**
 * WORKER-side dispatch (PR-150/151). Every case here runs with
 * `NOTIFICATION_ENABLED` conceptually "false" — the transport passed in is
 * whatever the caller injects (mirroring `notifications.module.ts`'s
 * factory picking `NoopNotificationTransport` in that case) — so these
 * tests prove the DISPATCH DECISION (a `notification` row created/updated,
 * the transport invoked with the right content) without any real SMTP relay
 * (slice-11a-brief.md item 3: "never a real email").
 */
function fakePrisma(
  overrides: {
    appUser?: unknown;
    notificationCreate?: unknown;
    job?: unknown;
  } = {},
) {
  const created = { id: 'notif-1' };
  return {
    appUser: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          overrides.appUser === undefined
            ? { id: 'recipient-1', emailCt: Buffer.from('ct'), dekVersion: 1 }
            : overrides.appUser,
        ),
    },
    notification: {
      create: jest.fn().mockResolvedValue(overrides.notificationCreate ?? created),
      update: jest.fn().mockResolvedValue({}),
    },
    job: {
      findUnique: jest.fn().mockResolvedValue(overrides.job),
    },
  };
}

function fakeFieldEncryption(email = 'verifier@example.com') {
  return { decrypt: jest.fn().mockReturnValue(email) };
}

function fakeTransport(
  kind: 'smtp' | 'noop' = 'noop',
): NotificationTransport & { send: jest.Mock } {
  return { kind, send: jest.fn().mockResolvedValue(undefined) };
}

describe('NotificationDispatchService#dispatch — the dispatch DECISION (PR-106/PR-150/151)', () => {
  it('creates a queued notification row, decrypts the recipient email via the established path, and calls the transport', async () => {
    const prisma = fakePrisma();
    const fieldEncryption = fakeFieldEncryption('verifier@example.com');
    const transport = fakeTransport('noop');
    const eligibility = { findEligibleVerifierIds: jest.fn(), findUsersWithRoleInScope: jest.fn() };
    const service = new NotificationDispatchService(
      prisma as never,
      fieldEncryption as never,
      transport,
      eligibility as never,
    );

    await service.dispatch({
      recipientId: 'recipient-1',
      templateCode: 'RECORD_SUBMITTED',
      entityType: 'job',
      entityId: 'job-1',
      payload: { jobNumber: 'PM-2026-000431' },
    });

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'queued', recipientId: 'recipient-1' }),
      }),
    );
    expect(fieldEncryption.decrypt).toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'verifier@example.com' }),
    );
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'sent' }) }),
    );
  });

  it('never passes the recipient address to Prisma or logs it — only the id (PR-106)', async () => {
    const prisma = fakePrisma();
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption('should-never-appear@example.com') as never,
      fakeTransport(),
      { findEligibleVerifierIds: jest.fn(), findUsersWithRoleInScope: jest.fn() } as never,
    );
    await service.dispatch({
      recipientId: 'recipient-1',
      templateCode: 'JOB_ASSIGNED',
      entityType: 'job',
      entityId: 'job-1',
      payload: {},
    });
    const createCallJson = JSON.stringify(prisma.notification.create.mock.calls[0]);
    expect(createCallJson).not.toContain('should-never-appear@example.com');
  });

  it('records state=failed (not a thrown exception) when the recipient does not exist', async () => {
    const prisma = fakePrisma({ appUser: null });
    const transport = fakeTransport();
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption() as never,
      transport,
      { findEligibleVerifierIds: jest.fn(), findUsersWithRoleInScope: jest.fn() } as never,
    );

    await service.dispatch({
      recipientId: 'ghost-user',
      templateCode: 'JOB_ASSIGNED',
      entityType: 'job',
      entityId: 'job-1',
      payload: {},
    });

    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'failed', failedReason: 'recipient not found' }),
      }),
    );
  });

  it('records state=failed when the transport itself throws (never crashes the worker)', async () => {
    const prisma = fakePrisma();
    const transport = fakeTransport();
    transport.send.mockRejectedValue(new Error('ECONNREFUSED'));
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption() as never,
      transport,
      { findEligibleVerifierIds: jest.fn(), findUsersWithRoleInScope: jest.fn() } as never,
    );

    await expect(
      service.dispatch({
        recipientId: 'recipient-1',
        templateCode: 'JOB_ASSIGNED',
        entityType: 'job',
        entityId: 'job-1',
        payload: {},
      }),
    ).resolves.toBeUndefined();

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'failed', failedReason: 'ECONNREFUSED' }),
      }),
    );
  });
});

describe('NotificationDispatchService#dispatchEscalation — PR-077 "fires a notification if it matures"', () => {
  it('resolves recipients by the configured escalate-to role and dispatches to each', async () => {
    const prisma = fakePrisma({
      job: {
        id: 'job-1',
        jobNumber: 'PM-2026-000431',
        status: 'submitted',
        currentStageOrdinal: 1,
        approvalRouteId: 'route-1',
        asset: { areaId: 'area-1' },
      },
    });
    const transport = fakeTransport();
    const eligibility = {
      findEligibleVerifierIds: jest.fn(),
      findUsersWithRoleInScope: jest.fn().mockResolvedValue(['escalation-target-1']),
    };
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption() as never,
      transport,
      eligibility as never,
    );

    await service.dispatchEscalation({
      jobId: 'job-1',
      stageOrdinal: 1,
      recipientRoleCode: 'TEAM_LEADER',
    });

    expect(eligibility.findUsersWithRoleInScope).toHaveBeenCalledWith('TEAM_LEADER', 'area-1');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ templateCode: 'VERIFICATION_ESCALATED' }),
      }),
    );
  });

  it('falls back to the currently-eligible verifiers when no escalate-to role is configured', async () => {
    const prisma = fakePrisma({
      job: {
        id: 'job-1',
        jobNumber: 'PM-2026-000431',
        status: 'submitted',
        currentStageOrdinal: 1,
        approvalRouteId: 'route-1',
        asset: { areaId: 'area-1' },
      },
    });
    const eligibility = {
      findEligibleVerifierIds: jest.fn().mockResolvedValue(['fallback-verifier-1']),
      findUsersWithRoleInScope: jest.fn(),
    };
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption() as never,
      fakeTransport(),
      eligibility as never,
    );

    await service.dispatchEscalation({ jobId: 'job-1', stageOrdinal: 1, recipientRoleCode: null });

    expect(eligibility.findEligibleVerifierIds).toHaveBeenCalledWith({
      approvalRouteId: 'route-1',
      currentStageOrdinal: 1,
      areaId: 'area-1',
    });
  });

  it('SKIPS sending when the job already moved past the escalated stage (race with cancellation)', async () => {
    const prisma = fakePrisma({
      job: {
        id: 'job-1',
        jobNumber: 'PM-2026-000431',
        status: 'archived', // already verified/archived by the time this matured
        currentStageOrdinal: null,
        approvalRouteId: 'route-1',
        asset: { areaId: 'area-1' },
      },
    });
    const transport = fakeTransport();
    const eligibility = { findEligibleVerifierIds: jest.fn(), findUsersWithRoleInScope: jest.fn() };
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption() as never,
      transport,
      eligibility as never,
    );

    await service.dispatchEscalation({ jobId: 'job-1', stageOrdinal: 1, recipientRoleCode: null });

    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('SKIPS when the job has since advanced to a DIFFERENT stage (also a race guard)', async () => {
    const prisma = fakePrisma({
      job: {
        id: 'job-1',
        jobNumber: 'PM-2026-000431',
        status: 'submitted',
        currentStageOrdinal: 2, // advanced past stage 1 already
        approvalRouteId: 'route-1',
        asset: { areaId: 'area-1' },
      },
    });
    const transport = fakeTransport();
    const service = new NotificationDispatchService(
      prisma as never,
      fakeFieldEncryption() as never,
      transport,
      { findEligibleVerifierIds: jest.fn(), findUsersWithRoleInScope: jest.fn() } as never,
    );

    await service.dispatchEscalation({ jobId: 'job-1', stageOrdinal: 1, recipientRoleCode: null });

    expect(transport.send).not.toHaveBeenCalled();
  });
});
