import { test, expect } from '../support/fixtures';

/**
 * O-02, O-05 and O-15 all exercise the same underlying invariant from three
 * narrative angles: PR-WFD-05 / non-negotiable #1 — an outbox entry is
 * cleared only after the server's `applied: true` acknowledgement actually
 * reaches the client, and the client-generated id (ADR-008) makes a retry
 * safe even when the server DID already apply the mutation the first time.
 *
 * The fault is injected via FakeServer.dropNextOutboxResponseOnce: it
 * commits the mutation (increments appliedCount, stores the idempotency
 * result) and THEN aborts the HTTP response — this is deliberately not
 * `context.setOffline()`, because Chromium's offline emulation blocks a
 * request before it ever reaches a `page.route` handler (verified while
 * building this suite), which cannot model "the server saw it" at all.
 */

test('O-15: a response lost after the server commits leaves the entry retained, and it is applied exactly once', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();

  server.dropNextOutboxResponseOnce();
  const firstAttempt = page.waitForRequest('**/api/v1/sync/outbox');
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  const request = await firstAttempt;
  const mutationId = (request.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id;

  // The fault fired: the server already applied it once, even though the
  // client received no response and must still be showing it as pending.
  await expect.poll(() => server.appliedCount.get(mutationId)).toBe(1);
  await expect(page.getByText('Held on device')).toBeVisible();

  // The client must retry automatically (drain retries on the next
  // trigger); nudge it the same way reconnection would, and wait for the
  // record to reach fully-synced (Submit enabled) rather than a fixed delay.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled({ timeout: 10_000 });

  expect(server.appliedCount.get(mutationId)).toBe(1); // never twice
  const allIds = new Set(server.receivedBatches.flat().map((m) => m.id));
  expect(allIds.size).toBe(2); // both items, no phantom extra mutation
});

test('O-02: network killed mid-drain, then restored — no duplicate, no loss', async ({ signedInPage: page, server }) => {
  await page.getByText('PM-2026-000431').click();

  server.dropNextOutboxResponseOnce();
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(page.getByText('Held on device')).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled({ timeout: 10_000 });

  const ids = new Set(server.receivedBatches.flat().map((m) => m.id));
  expect(ids.size).toBe(1);
  for (const id of ids) expect(server.appliedCount.get(id)).toBe(1);
});

test('O-05: replaying an entire outbox batch (simulated double-send) never double-applies', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText('PM-2026-000431').click();

  const requestPromise = page.waitForRequest('**/api/v1/sync/outbox');
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  const request = await requestPromise;
  const mutations = (request.postDataJSON() as { mutations: unknown[] }).mutations;
  await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled({ timeout: 10_000 });

  // Simulate a duplicate transmission of the SAME batch — e.g. a retried
  // HTTP request whose first attempt actually arrived, replayed anyway —
  // directly at the endpoint the app itself talks to, with the exact same
  // Idempotency-Keys, modelling the fault at the transport layer rather
  // than through the app's own (already mutex-guarded) drain call.
  const replayResult = await page.evaluate(
    async (body) =>
      fetch('/api/v1/sync/outbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    { mutations },
  );

  expect(replayResult.results).toHaveLength(mutations.length);
  const id = (mutations[0] as { id: string }).id;
  expect(server.appliedCount.get(id)).toBe(1); // replay did not re-apply
});
