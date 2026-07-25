import { test, expect } from '@playwright/test';
import { FakeServer } from '../support/fake-server';

/**
 * O-09: device clock 2 hours fast — skew detected at bootstrap and
 * flagged; both timestamps stored. The unit suite (sync-engine.test.ts)
 * already proves the detection and storage logic thoroughly against real
 * IndexedDB; this proves the same fault is actually surfaced to the
 * technician in the real UI, through a real browser clock.
 */
test('O-09: a device clock 2 hours fast is flagged to the technician after bootstrap', async ({ page }) => {
  const server = new FakeServer();
  server.seedJob({
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetCode: 'AW03',
    frequency: 'M3',
    dueOn: '2026-08-01',
    items: [{ id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' }],
  });
  const realServerTime = new Date();
  server.serverTime = realServerTime.toISOString();
  await server.install(page);

  // Fake the BROWSER's clock to be 2 hours ahead of the (real) server time
  // the fake server reports — Playwright's Clock API drives the actual
  // `Date`/timers the page sees, so `new Date()` inside the app's own
  // bootstrap() call genuinely disagrees with `server.serverTime` by 2h.
  await page.clock.install({ time: new Date(realServerTime.getTime() + 2 * 60 * 60 * 1000) });

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText(/clock is about 2h ahead of the server/i)).toBeVisible({ timeout: 10_000 });
});
