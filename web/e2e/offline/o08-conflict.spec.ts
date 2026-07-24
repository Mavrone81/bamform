import { test, expect } from '../support/fixtures';

/**
 * O-08: the server rejects one mutation with 409; that mutation is
 * retained (not cleared, not silently discarded), the rest of the batch
 * still applies, and the conflict is surfaced to the technician (PR-064) —
 * distinctly from the ordinary "held on device" state (A-05: text+icon,
 * SyncStatusChip renders a dedicated "Conflict — needs your input" state).
 */
test('O-08: a 409 on one mutation is retained, the rest of the batch applies, and the conflict is surfaced', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();

  const items = page.locator('.checklist-item');

  // First item: applies cleanly.
  const firstRequest = page.waitForRequest('**/api/v1/sync/outbox');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  const req1 = await firstRequest;
  const id1 = (req1.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id;
  await expect.poll(() => server.appliedCount.get(id1)).toBe(1);

  // Second item: forced into a 409 — models a concurrent edit from another
  // device/actor on the same job (the genuine multi-actor case; O-13
  // exercises the version-tracking mechanism that produces this for real).
  server.forceNextConflictOnce();
  const secondRequest = page.waitForRequest('**/api/v1/sync/outbox');
  await items.nth(1).getByRole('button', { name: 'Done', exact: true }).click();
  await secondRequest;

  await expect(page.getByText('Conflict — needs your input')).toBeVisible({ timeout: 10_000 });
  // The first mutation is unaffected — one conflicting mutation does not
  // block the rest of the batch.
  expect(server.appliedCount.get(id1)).toBe(1);

  // Submit is blocked while a conflict is outstanding (non-negotiable #2's
  // guard: submitJob refuses while any outbox row remains, conflicted or not).
  const submitButton = page.getByRole('button', { name: /Submit|Sending/ });
  await expect(submitButton).toBeDisabled();
});
