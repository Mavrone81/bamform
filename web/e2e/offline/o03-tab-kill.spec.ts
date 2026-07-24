import { test, expect } from '@playwright/test';
import { FakeServer } from '../support/fake-server';

/**
 * O-03: kill the browser tab mid-drain, reopen — the outbox is intact in
 * IndexedDB (it is a durable browser-storage table, not in-memory state)
 * and resumes. Modelled here by closing the `Page` outright (not just
 * navigating away) while a mutation is deliberately stuck mid-drain
 * (server committed, response never delivered — same fault as O-15), then
 * opening a brand new `Page` in the SAME `BrowserContext`. IndexedDB is
 * scoped to the origin within a context, not to a single page/tab, so this
 * is a faithful model of "the tab was killed and reopened" without needing
 * a real OS-level process kill.
 */
test('O-03: outbox survives the tab being killed mid-drain and resumes on reopen', async ({ context, page }) => {
  const server = new FakeServer();
  server.seedJob({
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetCode: 'AW03',
    frequency: 'M3',
    dueOn: '2026-08-01',
    items: [
      { id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' },
      { id: 'item-2', itemNo: 2, instruction: 'Inspect wire bond capillary' },
    ],
  });
  await server.install(page);

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  await page.getByText('PM-2026-000431').click();
  server.dropNextOutboxResponseOnce();
  const request = page.waitForRequest('**/api/v1/sync/outbox');
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  const req = await request;
  const mutationId = (req.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id;
  await expect.poll(() => server.appliedCount.get(mutationId)).toBe(1); // server committed…
  await expect(page.getByText('Held on device')).toBeVisible(); // …client never found out

  // "Kill the tab" — close the page outright, mid-drain, without ever
  // having received the acknowledgement.
  await page.close();

  // "Reopen" — a brand new page in the same context (same origin storage,
  // i.e. the same IndexedDB the outbox lives in).
  const page2 = await context.newPage();
  await server.install(page2); // route interception is per-page in Playwright
  await page2.goto('/jobs');
  // A fresh page starts with no access token in memory (non-negotiable
  // #10 — it is never persisted) but silently re-authenticates via the
  // refresh cookie, exactly as a real reload would; the outbox itself is
  // entirely independent of auth state either way.
  await expect(page2.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await page2.getByText('PM-2026-000431').click();

  await expect(page2.getByText('Held on device')).toBeVisible();
  const retryRequest = page2.waitForRequest('**/api/v1/sync/outbox');
  await page2.evaluate(() => window.dispatchEvent(new Event('online')));
  const retry = await retryRequest;
  expect((retry.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id).toBe(mutationId);

  await expect(page2.getByRole('button', { name: 'Submit' })).toBeEnabled({ timeout: 10_000 });
  expect(server.appliedCount.get(mutationId)).toBe(1); // still exactly once
});
