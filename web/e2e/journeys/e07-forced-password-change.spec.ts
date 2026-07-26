import { test, expect, type Browser, type Page } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from '../support/fake-server';

/**
 * E-07: the forced password change (slice 13-MFA §7, review finding I-3).
 *
 * An ADMIN creates a user and chooses their password, so the admin knows that
 * user's credential — unacceptable for signature attribution under ISO 13485.
 * The server closes it with a global, deny-by-default guard: until the user
 * picks their own password, EVERY endpoint but three answers
 * `403 /errors/password-change-required`.
 *
 * Before this slice that produced a user who could sign in and then do
 * nothing, with a generic "could not reach the server" and no way out. This
 * journey is the proof that it no longer does — and it deliberately does NOT
 * pre-navigate to the change-password screen: the point is that the app
 * routes them there on its own, from a 403 it did not predict.
 */

const JOB: SeedJob = {
  id: 'job-e07',
  jobNumber: 'PM-2026-000507',
  assetCode: 'AW09',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-e07-1', itemNo: 1, instruction: 'Check heater block temperature' }],
};

const NEW_PASSWORD = 'a-brand-new-password-2026';

function viewportFrom(testInfo: {
  project: { use: { viewport?: { width: number; height: number } | null } };
}) {
  return testInfo.project.use.viewport ?? { width: 1280, height: 900 };
}

async function withPage(
  browser: Browser,
  server: FakeServer,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await server.install(page);
  await run(page);
  await context.close();
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function submitChange(page: Page, current: string, next: string): Promise<void> {
  for (const [selector, value] of [
    ['#current-password', current],
    ['#new-password', next],
    ['#confirm-password', next],
  ] as const) {
    const field = page.locator(selector);
    await field.scrollIntoViewIfNeeded();
    await field.fill(value);
  }
  const submit = page.getByRole('button', { name: 'Change password' });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
}

test('E-07: an admin-created user is routed to the change-password screen and can free themselves', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.seedMustChangePassword(E2E_USERS.technician.id);
  const viewport = viewportFrom(testInfo);

  await withPage(browser, server, viewport, async (page) => {
    await signIn(page, E2E_USERS.technician.email, E2E_PASSWORD);

    // Signing in SUCCEEDS — the 403 comes from the first real request the app
    // makes afterwards, and the app reacts to it rather than predicting it.
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/set by an administrator/i);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toHaveCount(0);

    // The client-side guidance is guidance, and it blocks the obvious errors
    // before a request is even made.
    const submit = page.getByRole('button', { name: 'Change password' });
    await page.locator('#current-password').fill(E2E_PASSWORD);
    await page.locator('#new-password').fill('short');
    await page.locator('#confirm-password').fill('short');
    await expect(submit).toBeDisabled();
    await expect(page.getByText(/at least 12 characters/i).first()).toBeVisible();

    await page.locator('#new-password').fill(NEW_PASSWORD);
    await page.locator('#confirm-password').fill('something-else-entirely');
    await expect(page.getByText(/do not match/i)).toBeVisible();
    await expect(submit).toBeDisabled();

    // A wrong CURRENT password is the server's call, not the screen's.
    await submitChange(page, 'not-the-right-password', NEW_PASSWORD);
    await expect(page.getByRole('alert').last()).toContainText(
      /current password was not accepted/i,
    );
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();

    // The real change releases the gate and the session carries straight on
    // — no second sign-in.
    await submitChange(page, E2E_PASSWORD, NEW_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });

  // The change was real: the old password no longer works, the new one does.
  await withPage(browser, server, viewport, async (page) => {
    await signIn(page, E2E_USERS.technician.email, E2E_PASSWORD);
    await expect(page.getByRole('alert')).toContainText(/Sign-in failed/i);

    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });
});

test('E-07e: a forced user who cannot change their password can still sign out', async ({
  browser,
}, testInfo) => {
  // Review finding I-3. The gate is rendered in place of the whole app and
  // nothing else in it calls `logout()`, so before this the screen was a trap:
  // a user who was told their temporary password over the phone and mis-heard
  // it cannot supply the "current password" this form needs, and a reload does
  // not free them — the in-memory latch clears, then the first authenticated
  // request 403s and sets it again. Their only remedy was an out-of-band admin
  // reset, with no way even to leave the screen and no way to ask.
  const server = new FakeServer();
  server.seedJob(JOB);
  server.seedMustChangePassword(E2E_USERS.technician.id);
  const viewport = viewportFrom(testInfo);

  await withPage(browser, server, viewport, async (page) => {
    await signIn(page, E2E_USERS.technician.email, E2E_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();

    // The trap, demonstrated: a reload lands them right back here.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();

    const signOut = page.getByRole('button', { name: 'Sign out' });
    await signOut.scrollIntoViewIfNeeded();
    await signOut.click();

    // Out — genuinely, not just visually: the sign-in form is back and the
    // gate has released rather than re-rendering over it.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Change your password' })).toHaveCount(0);

    // ...and it survives a reload, which the gate itself does not: the session
    // genuinely ended rather than the latch merely being forgotten.
    await page.reload();
    await expect(page.getByLabel('Email')).toBeVisible();

    // And the gate is not weakened: signing straight back in returns them to
    // it. Leaving is not the same as getting past it.
    await signIn(page, E2E_USERS.technician.email, E2E_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toHaveCount(0);
  });
});

test('E-07b: a user who is NOT forced can still change their password voluntarily', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    await signIn(page, E2E_USERS.technician.email, E2E_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

    const link = page.getByRole('button', { name: 'Change password' });
    await link.scrollIntoViewIfNeeded();
    await link.click();

    await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
    // No forced-change banner: this user chose to be here.
    await expect(page.getByText(/set by an administrator/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to your jobs' })).toBeVisible();

    await submitChange(page, E2E_PASSWORD, NEW_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
    expect(server.passwordOf(E2E_USERS.technician.id)).toBe(NEW_PASSWORD);
  });
});

test('E-07c: an ADMIN can reset a locked-out user’s authenticator, behind an explicit confirmation', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.seedMfaEnrolment(E2E_USERS.engineer.id);
  const codes = server.seedRecoveryCodes(E2E_USERS.engineer.id);
  expect(codes).toHaveLength(10);

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    // MFA is OFF on this server, so the ADMIN signs in in one step — the
    // reset endpoint does not depend on the flag.
    await signIn(page, E2E_USERS.admin.email, E2E_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

    const entry = page.getByRole('button', { name: /Reset a user/i });
    await entry.scrollIntoViewIfNeeded();
    await entry.click();

    await expect(
      page.getByRole('heading', { name: /Reset a user.s authenticator/i }),
    ).toBeVisible();

    const field = page.locator('#mfa-reset-user-id');
    await field.scrollIntoViewIfNeeded();
    await field.fill(E2E_USERS.engineer.id);

    // Nothing destructive happens on the first click — the consequence is
    // spelled out and a second, explicit confirmation is required.
    const start = page.getByRole('button', { name: /Reset this user/i });
    await start.scrollIntoViewIfNeeded();
    await start.click();
    await expect(page.getByRole('alert')).toContainText(/voids all ten of their recovery codes/i);
    expect(server.isEnrolled(E2E_USERS.engineer.id)).toBe(true);

    const confirm = page.getByRole('button', { name: 'Yes, reset it' });
    await confirm.scrollIntoViewIfNeeded();
    await confirm.click();

    await expect(page.getByRole('status')).toContainText(/was reset/i);
    expect(server.isEnrolled(E2E_USERS.engineer.id)).toBe(false);
  });
});

test('E-07d: the reset control is not offered to a non-admin, and the server refuses them anyway', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.seedMfaEnrolment(E2E_USERS.engineer.id);

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    await signIn(page, E2E_USERS.technician.email, E2E_PASSWORD);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

    // Presentation: the technician is not offered the control...
    await expect(page.getByRole('button', { name: /Reset a user/i })).toHaveCount(0);

    // ...but that is NOT the enforcement (non-negotiable #6). The screen is
    // reachable by URL, and the SERVER is what says no.
    await page.goto('/admin/mfa-reset');
    const field = page.locator('#mfa-reset-user-id');
    await field.scrollIntoViewIfNeeded();
    await field.fill(E2E_USERS.engineer.id);
    await page.getByRole('button', { name: /Reset this user/i }).click();
    await page.getByRole('button', { name: 'Yes, reset it' }).click();

    // Two banners carry role="alert" on this screen (the destructive-action
    // warning and the server's error), so this filters for the one under
    // test rather than assuming a DOM order.
    await expect(page.getByRole('alert').filter({ hasText: /forbidden/i })).toBeVisible();
    expect(server.isEnrolled(E2E_USERS.engineer.id)).toBe(true);
  });
});
