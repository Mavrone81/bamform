import { test, expect } from '@playwright/test';
import { FakeServer, type SeedJob } from '../support/fake-server';

/**
 * O-16: a batch of exactly 200 queued mutations is accepted; a batch of
 * 201 is rejected — the client must never construct one over the cap
 * (`api/openapi.yaml` `/sync/outbox` `mutations.maxItems: 200`) in the
 * first place, chunking a larger queue instead (outbox.ts `drainAll`).
 *
 * Driven through 205 real taps on the real record-capture screen while
 * offline, then a single reconnect — real IndexedDB, real UI, real
 * outbox.ts chunking, only the entry count is unrealistically high for a
 * single PM record (a real 14-item form would never approach this; the
 * cap is about total queued mutations across however many jobs are
 * pending, which this stands in for economically).
 */
test.setTimeout(60_000);

test('O-16: a queue of 205 mutations drains in batches capped at 200, never exceeding it', async ({ page }) => {
  const items: SeedJob['items'] = Array.from({ length: 205 }, (_, i) => ({
    id: `item-${i}`,
    itemNo: i + 1,
    instruction: `Check point ${i + 1}`,
  }));
  const server = new FakeServer();
  server.seedJob({
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetCode: 'AW03',
    frequency: 'M3',
    dueOn: '2026-08-01',
    items,
  });
  await server.install(page);

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  await page.getByText('PM-2026-000431').click();
  await page.context().setOffline(true);

  const doneButtons = page.getByRole('button', { name: 'Done', exact: true });
  await expect(doneButtons).toHaveCount(205); // waits for the real render, unlike .count()
  const count = 205;
  for (let i = 0; i < count; i++) {
    await doneButtons.nth(i).click();
  }
  // Confirm all 205 landed in IndexedDB (not just clicked) before reconnecting.
  await expect(doneButtons.nth(count - 1)).toHaveAttribute('aria-pressed', 'true');

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled({ timeout: 30_000 });

  expect(server.receivedBatches.length).toBeGreaterThanOrEqual(2); // 205 could not fit in one batch
  for (const batch of server.receivedBatches) {
    expect(batch.length).toBeLessThanOrEqual(200); // the cap the client must never exceed
  }
  expect(server.receivedBatches.some((b) => b.length === 200)).toBe(true); // a full 200 WAS accepted
  expect(server.receivedBatches.reduce((n, b) => n + b.length, 0)).toBe(205); // all 205 arrived, none lost
});
