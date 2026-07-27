import { test, expect, signInAs, DEFAULT_JOB } from '../support/fixtures';
import { E2E_USERS } from '../support/fake-server';

/**
 * SYS-6, end to end on one shared "tablet" (one browser context, exactly as
 * a plant-floor device is shared):
 *
 *  O-17 — user A's unsent offline work is neither shown to nor drained
 *         under user B, and drains under A when A signs back in.
 *  O-19 — signing out with unsent work warns, and proceeding keeps the
 *         work intact rather than stranding it silently.
 */
test('O-17/O-19: shared-tablet handover — A records offline, is warned at sign-out, B neither sees nor transmits A’s work, A’s return syncs it under A', async ({
  signedInPage: page,
  server,
}) => {
  // --- User A (technician) records an item OFFLINE. ---
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();
  await page.context().setOffline(true);
  const items = page.locator('.checklist-item');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(items.nth(0).getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // --- O-19: sign-out warns about the unsent entry. ---
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('1 unsent entry on this device')).toBeVisible();
  await expect(dialog.getByText(/NOT be transmitted until you sign back in/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Sign out anyway' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // --- Reconnect while SIGNED OUT: nothing may drain (no principal). ---
  await page.context().setOffline(false);
  await page.waitForTimeout(300); // give any (incorrect) drain a chance to fire
  expect(server.outboxRequestCount).toBe(0);

  // --- User B signs in on the same device. ---
  await signInAs(page, E2E_USERS.teamLeader.email);
  // B gets their own fresh copy of the job from bootstrap — with NO trace
  // of A's unsent local edit.
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();
  await expect(
    page.locator('.checklist-item').nth(0).getByRole('button', { name: 'Done', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  // And nothing was transmitted under B's identity.
  expect(server.outboxRequestCount).toBe(0);
  expect(server.receivedBatches).toHaveLength(0);

  // B signs out — no pending work of B's own, so NO warning dialog.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // --- User A returns: the held entry drains, under A, exactly once. ---
  await signInAs(page);
  await expect.poll(() => server.receivedBatches.length).toBeGreaterThan(0);
  expect(server.receivedBatches.flat()).toHaveLength(1);
  expect(Array.from(server.appliedCount.values())).toEqual([1]);
});
