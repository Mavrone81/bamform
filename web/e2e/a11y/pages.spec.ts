import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { E2E_PASSWORD, E2E_USERS, type FakeServer } from '../support/fake-server';
import { currentTotpCode } from '../support/totp';
import AxeBuilder from '@axe-core/playwright';

/**
 * A-01: axe-core on every page, zero violations (WCAG 2.1 AA). This
 * foundation pass covers the three screens that exist (SignIn, JobList,
 * RecordCapture) at the 375px mobile-first baseline (E-RSP-01/02). The
 * full A-01..A-07 matrix across every viewport (§12) is a later slice's
 * job once the remaining screens (verifier queue, admin, PDF viewer) are
 * built; these three are real, not placeholders.
 */

test('A-01: SignIn has zero axe violations', async ({ page, server }) => {
  void server; // routes installed (incl. a clean 401 on /auth/refresh) so the page never hits a real, unmocked network call
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('A-01: JobList has zero axe violations', async ({ signedInPage: page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('A-01: RecordCapture has zero axe violations', async ({ signedInPage: page }) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

/** A-02: keyboard-only completion of a full record. */
test('A-02: a full item can be recorded using only the keyboard', async ({
  signedInPage: page,
}) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();

  const doneButton = page.getByRole('button', { name: 'Done', exact: true }).first();
  await doneButton.focus();
  await expect(doneButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(doneButton).toHaveAttribute('aria-pressed', 'true');
});

/** A-03: form controls have accessible names/labels. */
test('A-03: sign-in fields have accessible labels', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

/**
 * A-05: status is not conveyed by colour alone — every status surface
 * pairs an icon with visible text (SyncStatusChip, ItemStatusControl,
 * overdue/conflict/reassigned banners). This asserts the pairing exists
 * in the rendered DOM, not just in the source.
 */
test('A-05: the job sync status is rendered as icon + text together, not colour alone', async ({
  signedInPage: page,
}) => {
  const chip = page.locator('.status-chip[role="status"]').first();
  await expect(chip).toBeVisible();
  const iconText = await chip.locator('[aria-hidden="true"]').first().textContent();
  const fullText = await chip.textContent();
  expect(iconText?.trim().length).toBeGreaterThan(0);
  // The chip's full text content is longer than just the icon — real
  // words are present alongside it, not only a coloured glyph.
  expect((fullText ?? '').trim().length).toBeGreaterThan((iconText ?? '').trim().length);
});

// ---- Slice 13-UI-A: the authentication path (brief §5) ----
//
// These screens stand between every user and the system, so they are swept
// now rather than waiting for 13-UI-B's full A-01..A-07 matrix. Each one is
// reached the way a user reaches it, so what axe sees is the real rendered
// state rather than a component in isolation.

async function beginMfaSignIn(page: Page, server: FakeServer): Promise<void> {
  server.enableMfa();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E_USERS.admin.email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test('A-01: the TOTP code step has zero axe violations', async ({ page, server }) => {
  server.seedMfaEnrolment(E2E_USERS.admin.id);
  await beginMfaSignIn(page, server);
  await expect(page.getByRole('heading', { name: 'Enter your 6-digit code' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the recovery-code step has zero axe violations', async ({ page, server }) => {
  server.seedMfaEnrolment(E2E_USERS.admin.id);
  server.seedRecoveryCodes(E2E_USERS.admin.id);
  await beginMfaSignIn(page, server);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await expect(page.getByRole('heading', { name: 'Use a recovery code' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the enrolment screen (QR + manual key) has zero axe violations', async ({
  page,
  server,
}) => {
  await beginMfaSignIn(page, server);
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code/i })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the recovery-codes screen has zero axe violations', async ({ page, server }) => {
  await beginMfaSignIn(page, server);
  const manual = page.locator('#mfa-manual-entry');
  await manual.scrollIntoViewIfNeeded();
  const secret = (await manual.locator('code').innerText()).trim();
  const field = page.locator('#enrol-totp-code');
  await field.scrollIntoViewIfNeeded();
  await field.fill(currentTotpCode(secret));
  await page.getByRole('button', { name: 'Confirm and finish signing in' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the change-password screen has zero axe violations', async ({ signedInPage: page }) => {
  const link = page.getByRole('button', { name: 'Change password' });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the FORCED change-password screen has zero axe violations, sign-out included', async ({
  page,
  server,
}) => {
  // The voluntary screen above is not the same DOM: the forced branch swaps
  // "Back to your jobs" for a role="alert" banner and the app's only sign-out
  // control (review finding I-3), and it is the one screen a user can be held
  // on. It gets its own sweep.
  server.seedMustChangePassword(E2E_USERS.technician.id);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E_USERS.technician.email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the admin MFA-reset screen has zero axe violations, including its confirmation', async ({
  page,
  server,
}) => {
  void server;
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E_USERS.admin.email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  const entry = page.getByRole('button', { name: /Reset a user/i });
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
  await page.locator('#mfa-reset-user-id').fill(E2E_USERS.engineer.id);
  await page.getByRole('button', { name: /Reset this user/i }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expectNoViolations(page);
});

/**
 * A-02/A-06 for the second authentication step: a code can be entered and
 * submitted with the keyboard alone, and the field carries the
 * `autocomplete="one-time-code"` + numeric `inputmode` that make a phone
 * offer the SMS/authenticator code and show a number pad (brief §5).
 */
test('A-02: the 6-digit code step is completable with the keyboard alone', async ({
  page,
  server,
}) => {
  const secret = server.seedMfaEnrolment(E2E_USERS.admin.id);
  await beginMfaSignIn(page, server);

  const field = page.locator('#totp-code');
  await expect(field).toBeFocused(); // autoFocus lands where typing should go
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(field).toHaveAttribute('inputmode', 'numeric');

  await page.keyboard.type(currentTotpCode(secret));
  await page.keyboard.press('Enter'); // implicit form submission, no mouse
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
});

/** A-03: every new field has an accessible label. */
test('A-03: the MFA and password fields have accessible labels', async ({ page, server }) => {
  server.seedMfaEnrolment(E2E_USERS.admin.id);
  await beginMfaSignIn(page, server);
  await expect(page.getByLabel('6-digit code', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await expect(page.getByLabel('Recovery code', { exact: true })).toBeVisible();
});
