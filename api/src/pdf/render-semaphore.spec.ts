import { RenderSemaphore } from './render-semaphore';

/** Deterministic control over "is this promise settled yet" without fake timers or wall-clock waits. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending microtasks (promise resolutions already scheduled) flush before the next assertion. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RenderSemaphore (PR-116 note / P-08 — concurrency-2 cap)', () => {
  it('rejects a non-positive concurrency limit', () => {
    expect(() => new RenderSemaphore(0)).toThrow();
    expect(() => new RenderSemaphore(-1)).toThrow();
  });

  it('allows up to maxConcurrent permits to be held simultaneously, and no more', async () => {
    const sem = new RenderSemaphore(2);
    const release1 = await sem.acquire();
    expect(sem.activeCount).toBe(1);
    const release2 = await sem.acquire();
    expect(sem.activeCount).toBe(2);

    // A third acquire must NOT resolve while two permits are held.
    let thirdAcquired = false;
    const thirdPromise = sem.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await flush();
    expect(thirdAcquired).toBe(false);
    expect(sem.activeCount).toBe(2);
    expect(sem.waitingCount).toBe(1);

    // Releasing one permit admits exactly the third waiter, never exceeding the cap.
    release1();
    const release3 = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    expect(sem.activeCount).toBe(2);
    expect(sem.waitingCount).toBe(0);

    release2();
    release3();
    expect(sem.activeCount).toBe(0);
  });

  it('serves waiters in FIFO order', async () => {
    const sem = new RenderSemaphore(1);
    const release1 = await sem.acquire();
    const order: number[] = [];
    const p2 = sem.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const p3 = sem.acquire().then((release) => {
      order.push(3);
      return release;
    });
    await flush();
    expect(order).toEqual([]);

    release1();
    const release2 = await p2;
    expect(order).toEqual([2]);

    release2();
    await p3;
    expect(order).toEqual([2, 3]);
  });

  it('release() is idempotent — calling it twice does not free an extra slot', async () => {
    const sem = new RenderSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.activeCount).toBe(0);

    // A single further acquire must still work (no negative/duplicated accounting).
    await sem.acquire();
    expect(sem.activeCount).toBe(1);
  });

  it('withPermit releases even when the wrapped function throws, unblocking the next waiter', async () => {
    const sem = new RenderSemaphore(1);
    await expect(
      sem.withPermit(async () => {
        throw new Error('render failed');
      }),
    ).rejects.toThrow('render failed');
    expect(sem.activeCount).toBe(0);

    let ran = false;
    await sem.withPermit(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('never exceeds the cap under many concurrent withPermit callers (P-08/concurrency-2 style load)', async () => {
    const sem = new RenderSemaphore(2);
    let observedMax = 0;
    const gate: Array<{ promise: Promise<void>; resolve: () => void }> = [];

    const callers = Array.from({ length: 6 }, () => {
      const d = deferred<void>();
      gate.push(d);
      return sem.withPermit(async () => {
        observedMax = Math.max(observedMax, sem.activeCount);
        await d.promise;
      });
    });

    await flush();
    // At most 2 should be inside the critical section at once, however many callers queued.
    expect(sem.activeCount).toBe(2);

    for (const d of gate) {
      d.resolve();
      // Yield so each release can admit the next waiter before resolving the following one.
      await flush();
    }

    await Promise.all(callers);
    expect(observedMax).toBe(2);
    expect(sem.activeCount).toBe(0);
  });
});
