/**
 * PR-116 note / P-08 — caps SIMULTANEOUS headless-Chromium renders at a
 * fixed limit (2), independent of BullMQ's own `Worker` `concurrency` option
 * (which only bounds how many QUEUE JOBS run at once, not how many Chromium
 * pages are open at once — a single `export` job renders many PDFs itself,
 * see `records-export.service.ts`). This is the SINGLE source of truth both
 * the `render` job handler and the `export` job handler funnel every
 * `renderRecordPdf` call through (`pdf-render.service.ts`), so the cap holds
 * regardless of which code path triggered the render.
 *
 * A plain counting semaphore over an in-memory FIFO wait queue — no timers,
 * no polling, so a test can assert its `activeCount`/`waitingCount` state
 * deterministically after each `acquire()`/`release()` rather than racing a
 * wall clock (slice-12-brief.md: "assert the semaphore, not a flaky
 * wall-clock race").
 */
export class RenderSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error(`RenderSemaphore requires maxConcurrent >= 1, got ${maxConcurrent}`);
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  /** Resolves once a permit is held; the caller MUST call the returned release function exactly once. */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.buildRelease();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve(this.buildRelease());
      });
    });
  }

  /** Convenience wrapper — acquires, runs `fn`, always releases (even on throw). */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private buildRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent — a caller calling release() twice must not double-free a slot
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
