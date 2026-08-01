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
 *
 * The first test below has the response actually settle (aborted) before
 * the tab closes, so `drain()`'s own catch block has a chance to revert
 * the row to `pending` before the kill. The second test below is the
 * TRUE mid-network-call window a reviewer flagged as a real gap: the
 * request never settles AT ALL — it hangs, exactly as a genuinely killed
 * tab would leave it — so the row is provably still `sending` (the
 * atomic-claim status, not yet reverted by anything) at the moment of
 * closure. Recovering from THAT specific state is what
 * `db.ts`'s `recoverStuckSendingRows` (wired into `BamFormDB`'s `ready`
 * event, so it runs before the first drain of any new session) exists for.
 */
test('O-03: outbox survives the tab being killed mid-drain and resumes on reopen', async ({
  context,
  page,
}) => {
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
  // Slice 16: session restore now triggers the resume drain ITSELF
  // (App.tsx drains for the signed-in principal the moment the session is
  // re-established — a device that stayed online would otherwise wait for
  // an `online` transition that never comes). Register the wait before
  // navigating so the automatic retry is captured.
  const retryRequest = page2.waitForRequest('**/api/v1/sync/outbox');
  await page2.goto('/jobs');
  // A fresh page starts with no access token in memory (non-negotiable
  // #10 — it is never persisted) but silently re-authenticates via the
  // refresh cookie, exactly as a real reload would; the outbox itself is
  // entirely independent of auth state either way.
  await expect(page2.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  const retry = await retryRequest;
  expect((retry.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id).toBe(
    mutationId,
  );

  await page2.getByText('PM-2026-000431').click();
  await expect(page2.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
    timeout: 10_000,
  });
  expect(server.appliedCount.get(mutationId)).toBe(1); // still exactly once
});

test('O-03 (true mid-send window): tab killed while the request is still in flight — row is stuck "sending", recovers on reopen and applies exactly once', async ({
  context,
  page,
}) => {
  const server = new FakeServer();
  server.seedJob({
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetCode: 'AW03',
    frequency: 'M3',
    dueOn: '2026-08-01',
    items: [{ id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' }],
  });
  await server.install(page);

  // Registered AFTER server.install(), so it takes priority for this one
  // pattern: the request reaches this handler (proving it was actually
  // sent) and then simply never resolves — never fulfilled, never
  // aborted, never continued. That is exactly what a genuinely killed tab
  // leaves behind: no response, no thrown error, nothing for drain()'s
  // catch block to ever run. The outbox row can therefore ONLY be in the
  // atomic-claim 'sending' state (never reverted) at the moment we close
  // the page below — unlike the test above, where the abort gives
  // drain() a chance to revert it to 'pending' before the kill.
  await page.route('**/api/v1/sync/outbox', () => new Promise<void>(() => {}));

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  await page.getByText('PM-2026-000431').click();
  const hungRequest = page.waitForRequest('**/api/v1/sync/outbox');
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await hungRequest; // confirms the request was actually sent (and is now hanging forever)

  // "Kill the tab" — close the page outright while that request is still
  // pending. Nothing server-side committed for this one (the fake
  // handler never got that far), which is fine — the point is the
  // CLIENT'S row, which must have been claimed 'sending' before the
  // network call was even made.
  await page.close();

  const page2 = await context.newPage();
  await server.install(page2);
  // Recovery must have already run (BamFormDB's `ready` handler, before
  // the first drain of this new session) — the row is reachable by
  // listDrainable again, and slice 16's session-restore drain (App.tsx)
  // sends it without needing an `online` transition. Register the wait
  // before navigating so that automatic retry is captured.
  const retryRequest = page2.waitForRequest('**/api/v1/sync/outbox');
  await page2.goto('/jobs');
  await expect(page2.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  const retry = await retryRequest;
  const mutationId = (retry.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id;

  await page2.getByText('PM-2026-000431').click();
  await expect(page2.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
    timeout: 10_000,
  });
  expect(server.appliedCount.get(mutationId)).toBe(1); // applied exactly once, no duplicate
});
