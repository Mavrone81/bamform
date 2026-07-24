import { SchedulerLockService } from './scheduler-lock.service';

/** Minimal fake standing in for the one ioredis surface this service uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      const nx = args.includes('NX');
      if (nx && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(async (script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

describe('SchedulerLockService (PR-051)', () => {
  it('acquire succeeds when the key is free and returns a token', async () => {
    const redis = fakeRedis();
    const service = new SchedulerLockService(redis as never);

    const token = await service.acquire(300);

    expect(token).not.toBeNull();
    expect(redis.set).toHaveBeenCalledWith('bf:lock:scheduler', token, 'EX', 300, 'NX');
  });

  it('a second acquire while the first is held returns null (I-INV-15 unit-level proof)', async () => {
    const redis = fakeRedis();
    const service = new SchedulerLockService(redis as never);

    const first = await service.acquire(300);
    const second = await service.acquire(300);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('release frees the lock so a subsequent acquire succeeds', async () => {
    const redis = fakeRedis();
    const service = new SchedulerLockService(redis as never);

    const token = await service.acquire(300);
    await service.release(token as string);
    const reacquired = await service.acquire(300);

    expect(reacquired).not.toBeNull();
  });

  it('release with a stale/foreign token is a no-op (never steals a live lock)', async () => {
    const redis = fakeRedis();
    const service = new SchedulerLockService(redis as never);

    await service.acquire(300); // real holder
    await service.release('some-other-workers-token');

    const stillHeld = await service.acquire(300);
    expect(stillHeld).toBeNull(); // the real holder's lock is untouched
  });
});
