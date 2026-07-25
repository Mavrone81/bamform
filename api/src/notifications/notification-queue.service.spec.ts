import { NotificationQueueService } from './notification-queue.service';

/** A minimal fake standing in for `bullmq`'s `Queue` — no Redis required (unit-level, job 3 has no Redis service container). */
function fakeQueue() {
  const jobs = new Map<string, { id: string; remove: jest.Mock }>();
  return {
    add: jest.fn(async (_name: string, _data: unknown, opts?: { jobId?: string }) => {
      if (opts?.jobId) {
        jobs.set(opts.jobId, { id: opts.jobId, remove: jest.fn(async () => undefined) });
      }
      return { id: opts?.jobId ?? 'auto' };
    }),
    addBulk: jest.fn(async () => []),
    getJob: jest.fn(async (id: string) => jobs.get(id) ?? null),
    __jobs: jobs,
  };
}

describe('NotificationQueueService (producer)', () => {
  it('escalationJobId is deterministic per job+stage — schedule/cancel agree without a stored id', () => {
    const queue = fakeQueue();
    const svc = new NotificationQueueService(queue as never);
    expect(svc.escalationJobId('job-1', 1)).toBe('escalation:job-1:1');
    expect(svc.escalationJobId('job-1', 2)).toBe('escalation:job-1:2');
  });

  it('enqueueNotification adds a "notification"-named job', async () => {
    const queue = fakeQueue();
    const svc = new NotificationQueueService(queue as never);
    await svc.enqueueNotification({
      recipientId: 'user-1',
      templateCode: 'JOB_ASSIGNED',
      entityType: 'job',
      entityId: 'job-1',
      payload: {},
    });
    expect(queue.add).toHaveBeenCalledWith(
      'notification',
      expect.objectContaining({ recipientId: 'user-1' }),
      expect.any(Object),
    );
  });

  it('enqueueNotifications is a no-op for an empty list (no BullMQ round trip)', async () => {
    const queue = fakeQueue();
    const svc = new NotificationQueueService(queue as never);
    await svc.enqueueNotifications([]);
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it('scheduleEscalation adds a delayed "escalation" job under a deterministic id', async () => {
    const queue = fakeQueue();
    const svc = new NotificationQueueService(queue as never);
    await svc.scheduleEscalation({
      jobId: 'job-1',
      stageOrdinal: 1,
      delayMs: 259_200_000,
      recipientRoleCode: null,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'escalation',
      { jobId: 'job-1', stageOrdinal: 1, recipientRoleCode: null },
      expect.objectContaining({ jobId: 'escalation:job-1:1', delay: 259_200_000 }),
    );
  });

  it('cancelEscalation removes the job if present', async () => {
    const queue = fakeQueue();
    const svc = new NotificationQueueService(queue as never);
    await svc.scheduleEscalation({
      jobId: 'job-1',
      stageOrdinal: 1,
      delayMs: 1000,
      recipientRoleCode: null,
    });
    const job = queue.__jobs.get('escalation:job-1:1')!;
    await svc.cancelEscalation('job-1', 1);
    expect(job.remove).toHaveBeenCalled();
  });

  it('cancelEscalation is a safe no-op when nothing was scheduled', async () => {
    const queue = fakeQueue();
    const svc = new NotificationQueueService(queue as never);
    await expect(svc.cancelEscalation('never-submitted', 1)).resolves.toBeUndefined();
  });
});
