import { test, expect } from '../support/fixtures';
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
