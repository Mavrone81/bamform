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

test('O-22a: a refusal is REQUESTED at sign-in but stays SILENT while nothing is at risk', async ({
  page,
  server,
}) => {
  void server;
  await stubPersistence(page, false);
  await signInAs(page);

  // Owner feedback from a real device (2026-07-28): the banner used to fire
  // on a refusal alone, so a phone holding nothing announced that "records
  // held on this device could be evicted" — warning about the loss of
  // records that did not exist. Eviction can only destroy UNSENT work, so
  // with an empty outbox there must be no banner at all.
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await expect(page.getByText(/has not protected offline storage/)).toBeHidden();

  const calls = await page.evaluate(
    () => (window as unknown as { __persistCalls: string[] }).__persistCalls,
  );
  expect(calls).toContain('persist'); // still genuinely requested, not assumed
});

test('O-22c: the warning DOES appear, with a count, once unsent records exist on a refused device', async ({
  page,
  server,
}) => {
  void server;
  await stubPersistence(page, false);
  await signInAs(page);

  // Capture one item offline so the device genuinely holds work that
  // eviction would destroy — the only state in which the warning is true.
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();
  await page.context().setOffline(true);
  const items = page.locator('.checklist-item');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(items.nth(0).getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Back to your jobs' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await expect(page.getByText(/1 record is waiting to send/)).toBeVisible();
  await expect(page.getByText(/has not protected offline storage/)).toBeVisible();
});

test('O-22b: a granted request stays silent — no scare banner when storage IS protected', async ({
  page,
  server,
}) => {
  void server;
  await stubPersistence(page, true);
  await signInAs(page);

  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await expect(page.getByText(/has not protected offline storage/)).toBeHidden();
  const calls = await page.evaluate(
    () => (window as unknown as { __persistCalls: string[] }).__persistCalls,
  );
  expect(calls).toContain('persist');
});
