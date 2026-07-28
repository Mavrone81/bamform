import { test, expect, signAndSubmit, DEFAULT_JOB } from '../support/fixtures';

/**
 * SYS-5 (O-20): before this slice one 409 wedged the device forever —
 * conflict rows are excluded from every drain and Submit is gated on an
 * empty outbox, and no screen called the recovery functions. These journeys
 * wedge a real device through the fake server's REAL optimistic-concurrency
 * tracking and recover it through the visible UI, both ways.
 */

test('O-20a: wedge → “Keep my entries and resend” → conflict clears with a refreshed ifMatch → Submit succeeds', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();
  const items = page.locator('.checklist-item');

  // First item applies cleanly (server draftVersion 1 → 2).
  const firstRequest = page.waitForRequest('**/api/v1/sync/outbox');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await firstRequest;

  // Second item is forced into a 409 — the wedge.
  server.forceNextConflictOnce();
  const secondRequest = page.waitForRequest('**/api/v1/sync/outbox');
  await items.nth(1).getByRole('button', { name: 'Done', exact: true }).click();
  await secondRequest;

  // The wedge is now VISIBLE and actionable — not a dead-end chip.
  await expect(page.getByText('Conflict — needs your input')).toBeVisible({ timeout: 10_000 });
  const panel = page.getByTestId('conflict-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/server has a newer version/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resolve the sync problem/ })).toBeDisabled();

  // Recover, keeping the technician's entries.
  await panel.getByRole('button', { name: 'Keep my entries and resend' }).click();

  // The retried mutation carries the REFRESHED ifMatch (the server's
  // current version), so it applies — the review's stale-replay trap is the
  // thing this assertion would catch.
  await expect(page.getByText('Conflict — needs your input')).toBeHidden({ timeout: 10_000 });
  const submit = page.getByRole('button', { name: 'Sign and submit', exact: true });
  await expect(submit).toBeEnabled({ timeout: 10_000 });

  await signAndSubmit(page);
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  expect(server.submitCount.get(DEFAULT_JOB.id)).toBe(1);
});

test('O-20b: wedge → “Discard mine, use the server’s” → local edit dropped, server truth restored, Submit unblocked', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  const items = page.locator('.checklist-item');

  server.forceNextConflictOnce();
  const request = page.waitForRequest('**/api/v1/sync/outbox');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await request;
  await expect(page.getByTestId('conflict-panel')).toBeVisible({ timeout: 10_000 });

  await page
    .getByTestId('conflict-panel')
    .getByRole('button', { name: 'Discard mine, use the server’s' })
    .click();

  await expect(page.getByText('Conflict — needs your input')).toBeHidden({ timeout: 10_000 });
  // The discarded edit is gone from the UI — the server's (unrecorded)
  // truth is back, honestly.
  await expect(items.nth(0).getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Sign and submit', exact: true })).toBeEnabled();
  // Nothing was ever applied server-side for the discarded mutation.
  expect(Array.from(server.appliedCount.values())).toHaveLength(0);
});

test('O-20c: recovery while offline says so and changes nothing — no half-recovered state', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  const items = page.locator('.checklist-item');

  server.forceNextConflictOnce();
  const request = page.waitForRequest('**/api/v1/sync/outbox');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await request;
  const panel = page.getByTestId('conflict-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });

  await page.context().setOffline(true);
  // Both actions disable offline, with an honest explanation.
  await expect(panel.getByRole('button', { name: 'Keep my entries and resend' })).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: 'Discard mine, use the server’s' }),
  ).toBeDisabled();
  await expect(panel.getByText(/Recovery needs a connection/)).toBeVisible();

  // Reconnect: the conflict is still there, still recoverable.
  await page.context().setOffline(false);
  await expect(panel.getByRole('button', { name: 'Keep my entries and resend' })).toBeEnabled();
});

test('O-20d (H-3): job reassigned away while edits were offline — non-409 failures get the recovery panel, and discard is a working exit while fully online', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();

  // Technician edits offline; meanwhile the job is reassigned away
  // server-side (slice 15's /assign made this a real flow).
  await page.context().setOffline(true);
  const items = page.locator('.checklist-item');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(items.nth(0).getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  server.removeJob(DEFAULT_JOB.id);

  // Reconnect: the drain's mutation is refused 404 → a `failed` row, the
  // class that previously wedged forever with NO recovery UI (SYS-5
  // reborn). The panel must appear, with the refusal copy, not the
  // newer-version copy.
  await page.context().setOffline(false);
  const panel = page.getByTestId('conflict-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText(/The server refused/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resolve the sync problem/ })).toBeDisabled();

  // The technician is ONLINE — discard must work, not claim "reconnect".
  await panel.getByRole('button', { name: 'Discard mine, use the server’s' }).click();
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText(/no longer available to you on the server/)).toBeVisible();
  // The job is honestly flagged: kept visible, but never submittable here.
  await expect(page.getByText(/reassigned or removed on the server/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Sign and submit|Sending|Resolve the sync problem/ }),
  ).toBeDisabled();
  // Nothing was ever applied server-side for the refused mutation.
  expect(Array.from(server.appliedCount.values())).toHaveLength(0);
});
