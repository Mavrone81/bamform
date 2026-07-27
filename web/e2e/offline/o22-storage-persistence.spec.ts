import { test as base, expect, type Page } from '@playwright/test';
import { FakeServer } from '../support/fake-server';
import { DEFAULT_JOB, signInAs } from '../support/fixtures';

/**
 * SYS-15 (O-22): `navigator.storage.persist()` is requested at sign-in and
 * the OUTCOME is surfaced — a refusal means the browser may evict the
 * origin's IndexedDB (and iOS wipes non-installed origins after 7 days),
 * i.e. unsent records can vanish silently, so the technician must be told.
 * The StorageManager is stubbed per test because a real browser's grant
 * decision is heuristic and non-deterministic.
 */

const test = base.extend<{ server: FakeServer }>({
  server: async ({ page }, use) => {
    const server = new FakeServer();
    server.seedJob(DEFAULT_JOB);
    await server.install(page);
    await use(server);
  },
});

async function stubPersistence(page: Page, granted: boolean): Promise<void> {
  await page.addInitScript((grant: boolean) => {
    const calls: string[] = [];
    (window as unknown as { __persistCalls: string[] }).__persistCalls = calls;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: () => {
          calls.push('persisted');
          return Promise.resolve(false);
        },
        persist: () => {
          calls.push('persist');
          return Promise.resolve(grant);
        },
        estimate: () => Promise.resolve({ usage: 0, quota: 1 }),
      },
    });
  }, granted);
}

test('O-22a: a persistence REFUSAL is requested at sign-in and surfaced in the job list sync area', async ({
  page,
  server,
}) => {
  void server;
  await stubPersistence(page, false);
  await signInAs(page);

  await expect(page.getByText(/not protected BamForm's offline storage/)).toBeVisible();
  const calls = await page.evaluate(
    () => (window as unknown as { __persistCalls: string[] }).__persistCalls,
  );
  expect(calls).toContain('persist'); // genuinely requested, not assumed
});

test('O-22b: a granted request stays silent — no scare banner when storage IS protected', async ({
  page,
  server,
}) => {
  void server;
  await stubPersistence(page, true);
  await signInAs(page);

  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await expect(page.getByText(/not protected BamForm's offline storage/)).toBeHidden();
  const calls = await page.evaluate(
    () => (window as unknown as { __persistCalls: string[] }).__persistCalls,
  );
  expect(calls).toContain('persist');
});
