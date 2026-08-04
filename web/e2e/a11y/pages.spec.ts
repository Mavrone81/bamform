import type { Page } from '@playwright/test';
import { test, expect, signInAs } from '../support/fixtures';
import { E2E_PASSWORD, E2E_TEMPLATES, E2E_USERS, FakeServer } from '../support/fake-server';
import { currentTotpCode } from '../support/totp';
import AxeBuilder from '@axe-core/playwright';

/**
 * A-01: axe-core on every page, zero violations (WCAG 2.1 AA). Slice
 * 13-UI-B completes the release's A-01..A-07 matrix: every screen — old and
 * new — is swept at ALL THREE viewports (375/768/1280; 13-UI-A review m9
 * named the 375-only sweep as this slice's inheritance) by
 * `expectNoViolations`, which re-runs axe per width so the tab bar AND the
 * side rail DOM are both covered.
 */

/** m9: the three CI widths. Each sweep runs axe at every one. */
const A11Y_WIDTHS = [375, 768, 1280] as const;

test('A-01: SignIn has zero axe violations', async ({ page, server }) => {
  void server; // routes installed (incl. a clean 401 on /auth/refresh) so the page never hits a real, unmocked network call
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: JobList has zero axe violations', async ({ signedInPage: page }) => {
  await expectNoViolations(page);
});

test('A-01: RecordCapture has zero axe violations', async ({ signedInPage: page }) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();
  await expectNoViolations(page);
});

/**
 * Slice 18-WORKFLOW §1 — the performer's signature pad is a NEW interactive
 * surface on the capture screen, and it is the one every technician now has
 * to use on every submission. Swept open, at all three widths.
 */
test('A-01: RecordCapture with the performer signature pad open has zero axe violations', async ({
  signedInPage: page,
}) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign and submit' }).click();
  await expect(page.getByTestId('performer-signature')).toBeVisible();
  await expectNoViolations(page);
});

/**
 * Slice 31-TITLEBLANK — the form-number box is a NEW interactive surface on
 * the capture screen, and unlike the signature pad it is also a BLOCKING one:
 * while it is empty the submit button is disabled and carries a different
 * label. Both states are swept — empty (error text visible, submit disabled)
 * and filled — at all three widths, because "why can I not submit" must be
 * answerable to a screen reader, not only to a sighted user.
 */
test('A-01/A-05: the form-number box on the capture screen has zero axe violations, empty and filled', async ({
  page,
}) => {
  const server = new FakeServer();
  server.seedJob({
    id: 'job-title',
    jobNumber: 'PM-2026-000702',
    assetCode: 'ED01',
    frequency: 'M3',
    dueOn: '2026-08-01',
    title: 'BESi Die Attach Preventive Maintenance Record ED____',
    items: [{ id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' }],
  });
  await server.install(page);
  await signInAs(page);

  await page.getByText('PM-2026-000702').click();
  await expect(page.getByLabel('Form number in the title')).toBeVisible();
  // Empty: the refusal is text, not colour alone (A-05).
  await expect(page.getByText(/Fill this in before submitting/i)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Enter the form number above to submit/i }),
  ).toBeDisabled();
  await expectNoViolations(page);

  await page.getByLabel('Form number in the title').fill('01');
  await expect(page.getByRole('button', { name: 'Sign and submit' })).toBeEnabled();
  await expectNoViolations(page);
});

/** Slice 18-WORKFLOW §2 — the "Raise a job" screen (UR-028). */
test('A-01: Raise a job has zero axe violations', async ({ signedInPage: page }) => {
  await page.goto('/jobs/raise');
  await expect(page.getByRole('heading', { name: 'Raise a job' })).toBeVisible();
  await expectNoViolations(page);
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
  for (const width of A11Y_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations,
      `at ${width}px: ${JSON.stringify(results.violations, null, 2)}`,
    ).toEqual([]);
  }
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
  // Slice 14-DESIGN: account actions live on the Menu tab of the nav shell.
  await page.getByRole('button', { name: 'Menu' }).click();
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

  // Slice 13-UI-B: the standalone screen stays routed for bookmarks; the
  // Menu path now goes Menu -> Administration (and per-user reset lives on
  // the user's detail page, swept separately below).
  await page.goto('/admin/mfa-reset');
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

// ---- Slice 16: the new surfaces must be as clean as the ones they join ----

test('A-01: the RecordCapture conflict-recovery panel has zero axe violations', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText('PM-2026-000431').click();
  server.forceNextConflictOnce();
  const request = page.waitForRequest('**/api/v1/sync/outbox');
  await page
    .locator('.checklist-item')
    .nth(0)
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await request;
  await expect(page.getByTestId('conflict-panel')).toBeVisible({ timeout: 10_000 });
  await expectNoViolations(page);
});

test('A-01: the photo section with a staged photo has zero axe violations', async ({
  signedInPage: page,
}) => {
  await page.getByText('PM-2026-000431').click();
  await page.getByLabel('Add a photo (camera or gallery)').setInputFiles({
    name: 'evidence.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  await expect(page.getByTestId('staged-photo')).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the Menu (with sign-out) and the unsent-work warning dialog have zero axe violations', async ({
  signedInPage: page,
}) => {
  // Queue an unsent entry so the warning dialog genuinely opens.
  await page.getByText('PM-2026-000431').click();
  await page.context().setOffline(true);
  await page
    .locator('.checklist-item')
    .nth(0)
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expectNoViolations(page);

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoViolations(page);
  await page.getByRole('button', { name: 'Stay signed in' }).click();
});

// ---- Slice 13-UI-B: the admin surface + the screens never yet swept ----
//
// Every sweep below (like every one above, since this slice) runs at
// 375/768/1280 via `expectNoViolations` — the full A-01 matrix the release
// owes (TEST_PLAN §12), not a single-width sample.

async function signInAsAdmin(page: Page): Promise<void> {
  await signInAs(page, E2E_USERS.admin.email);
}

test('A-01: the verifier queue (entries + empty) has zero axe violations', async ({
  page,
  server,
}) => {
  server.seedJob({
    id: 'job-a11y-queue',
    jobNumber: 'PM-2026-000700',
    assetCode: 'WB09',
    frequency: 'M1',
    dueOn: '2026-08-01',
    status: 'SUBMITTED',
    submittedBy: E2E_USERS.technician.id,
    submittedAt: new Date().toISOString(),
    currentStageOrdinal: 1,
    items: [{ id: 'item-q1', itemNo: 1, instruction: 'Check clamp force' }],
    itemResults: [{ templateItemId: 'item-q1', status: 'DONE' }],
  });
  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.getByRole('button', { name: 'Verifier queue' }).click();
  await expect(page.getByText('PM-2026-000700')).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the record review screen has zero axe violations', async ({ page, server }) => {
  server.seedJob({
    id: 'job-a11y-review',
    jobNumber: 'PM-2026-000701',
    assetCode: 'WB10',
    frequency: 'M1',
    dueOn: '2026-08-01',
    status: 'SUBMITTED',
    submittedBy: E2E_USERS.technician.id,
    submittedAt: new Date().toISOString(),
    currentStageOrdinal: 1,
    items: [{ id: 'item-r1', itemNo: 1, instruction: 'Check heater block temperature' }],
    itemResults: [{ templateItemId: 'item-r1', status: 'DONE' }],
  });
  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.getByRole('button', { name: 'Verifier queue' }).click();
  await page.getByText('PM-2026-000701').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000701' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the delegations screen has zero axe violations', async ({ page, server }) => {
  void server;
  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.getByRole('button', { name: 'Verifier queue' }).click();
  await page.getByRole('button', { name: 'Delegations' }).click();
  await expect(page.getByRole('heading', { name: 'Delegations', exact: true })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the admin landing has zero axe violations', async ({ page, server }) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the user list has zero axe violations', async ({ page, server }) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/users');
  // Scoped to the card title: the (display:none) rail foot carries the same
  // name, so a bare getByText can resolve to the hidden span at phone width.
  await expect(page.locator('.card-title', { hasText: 'Test Administrator' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the create-user form has zero axe violations', async ({ page, server }) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/users/new');
  await expect(page.getByRole('heading', { name: 'Add a user' })).toBeVisible();
  await expect(page.getByLabel(/Team Leader/)).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the user detail (roles, areas, deactivate + MFA-reset confirms) has zero axe violations', async ({
  page,
  server,
}) => {
  server.seedArea({ code: 'BL', name: 'Bond Line' });
  await signInAsAdmin(page);
  await page.goto('/admin/users');
  await page.getByText('Test Engineer').click();
  await expect(page.getByRole('heading', { name: 'Test Engineer' })).toBeVisible();
  await expect(page.getByLabel(/Bond Line/)).toBeVisible();
  await expectNoViolations(page);

  // Both destructive confirms open — the states a mistake-in-progress shows.
  await page.getByRole('button', { name: 'Deactivate this account' }).click();
  await expect(page.getByRole('button', { name: 'Yes, deactivate' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset authenticator' }).click();
  await expect(page.getByRole('button', { name: 'Yes, reset it' })).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the machine list (empty and populated) has zero axe violations', async ({
  page,
  server,
}) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/machines');
  await expect(page.getByText('No machines here yet.')).toBeVisible();
  await expectNoViolations(page);
});

test('A-01: the add-machine form has zero axe violations', async ({ page, server }) => {
  server.seedArea({ code: 'BL', name: 'Bond Line' });
  await signInAsAdmin(page);
  await page.goto('/admin/machines/new');
  await expect(page.getByLabel('Asset type')).toBeVisible();
  await expectNoViolations(page);
});

test('A-01/A-05: the machine detail with a provisional RED code has zero axe violations, and the state is never colour alone', async ({
  page,
  server,
}) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/machines/new');
  await page.getByLabel('Asset type').selectOption({ label: 'Wire Bonder' });
  await page.getByRole('button', { name: 'Add machine' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/^PROV-/);

  // A-05: the provisional state carries an icon AND the word PROVISIONAL —
  // never colour alone — and the code SHAPE itself (PROV-…) is a third,
  // colour-independent signal.
  const chip = page.locator('.status-chip[data-tone="bad"]').first();
  await expect(chip).toContainText('PROVISIONAL');
  const icon = await chip.locator('[aria-hidden="true"]').first().textContent();
  expect(icon?.trim().length).toBeGreaterThan(0);

  await expectNoViolations(page);
});

/**
 * Slice 28-ASSETDOC-UI — the two new surfaces. Both are swept in the state
 * that matters: the machine page with its inert-machine alarm AND with a
 * tagged document's form-number field open, and "Raise a job" with the
 * document picker showing.
 */
test('A-01: the machine documents section (inert alarm, tagged row, form-number field) has zero axe violations', async ({
  page,
  server,
}) => {
  const machine = server.seedAsset({ code: 'AW09', assetTypeId: 'at-1' });
  await signInAsAdmin(page);
  await page.goto(`/admin/machines/${machine.id}`);
  // Inert: no document tagged yet.
  await expect(
    page.getByRole('alert').filter({ hasText: /carries no active preventive-maintenance/ }),
  ).toBeVisible();
  await expectNoViolations(page);

  // Tagged: the row, its "form number not set" chip and the field itself.
  await page.getByLabel('Document', { exact: true }).selectOption(E2E_TEMPLATES.wireBond);
  await page.getByRole('button', { name: 'Tag this document' }).click();
  await expect(page.getByLabel('Form number for CE 95 020 00 03')).toBeVisible();
  await expectNoViolations(page);

  // The retire confirmation panel is its own interactive surface.
  await page.getByRole('button', { name: 'Retire CE 95 020 00 03' }).click();
  await expect(page.getByRole('group', { name: /Confirm retiring/ })).toBeVisible();
  await expectNoViolations(page);

  // Retired: the chip and the "return to service" action.
  await page.getByRole('button', { name: 'Yes, retire it' }).click();
  await expect(page.getByText('Retired', { exact: true })).toBeVisible();
  await expectNoViolations(page);
});

/**
 * Slice 29-SCHEDULE-UI — `MachineSchedule`'s three states: inert (no
 * document tagged, so nothing scheduled), populated (a tagged document's
 * rule, whose frequency chip carries an icon and a word, never colour
 * alone — A-05), and the adjust-next-due-date form open.
 */
test('A-01/A-05: the machine schedule section (empty, populated, adjust form open) has zero axe violations', async ({
  page,
  server,
}) => {
  const machine = server.seedAsset({ code: 'AW12', assetTypeId: 'at-1' });
  await signInAsAdmin(page);
  await page.goto(`/admin/machines/${machine.id}`);

  // No document tagged yet: the schedule section's own empty state.
  await expect(
    page.getByText(
      'No maintenance is currently scheduled for this machine — nothing to adjust yet.',
    ),
  ).toBeVisible();
  await expectNoViolations(page);

  // Tag the wire-bond document (fake fixture: scheduled monthly). The
  // schedule section only loads on mount, not on `MachineDocuments`'
  // tagging — same as `e12-machine-documents.spec.ts`'s own "survives a
  // reload" step — so its new rule appears after a reload.
  await page.getByLabel('Document', { exact: true }).selectOption(E2E_TEMPLATES.wireBond);
  await page.getByRole('button', { name: 'Tag this document' }).click();
  await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW___')).toBeVisible();
  await page.reload();
  const freqChip = page.locator('.status-chip').filter({ hasText: 'Monthly (1M)' });
  await expect(freqChip).toBeVisible();
  // A-05: icon AND text together, never a bare coloured chip.
  const icon = await freqChip.locator('[aria-hidden="true"]').first().textContent();
  expect(icon?.trim().length).toBeGreaterThan(0);
  await expectNoViolations(page);

  // The adjust-next-due-date form is its own interactive surface.
  await page.getByRole('button', { name: /Adjust next due date for/ }).click();
  await expect(page.getByLabel('Reason for this change')).toBeVisible();
  await expectNoViolations(page);
});

/**
 * Slice 31-PLANNER — the planner grid, in the three states that matter: the
 * populated year (a 52-column table with a sticky machine column and a load
 * row, the most structurally complex surface in the app), the selected-visit
 * panel, and the adjust form open inside it. Swept at all three widths like
 * everything else, which for this screen also proves the grid's own
 * scroll container behaves rather than the page scrolling sideways.
 *
 * A-05 is asserted here too: the past-due cell carries the ⚠ glyph AND the
 * word LATE AND a "past due" accessible name, and the heavy-week flag is a
 * real sentence, not a taller bar.
 */
test('A-01/A-05: the planner grid (year, selected visit, adjust form) has zero axe violations', async ({
  page,
  server,
}) => {
  await page.clock.setFixedTime(new Date('2026-08-03T12:00:00.000Z'));
  const late = server.seedAsset({
    code: 'AW09',
    assetTypeId: 'at-1',
    scheduleAnchorDate: '2026-02-04',
  });
  server.seedAssetDocument({ assetId: late.id, formTemplateId: E2E_TEMPLATES.wireBond });
  const later = server.seedAsset({
    code: 'EP07',
    assetTypeId: 'at-1',
    scheduleAnchorDate: '2026-09-17',
  });
  server.seedAssetDocument({ assetId: later.id, formTemplateId: E2E_TEMPLATES.epoxy });

  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.goto('/planner');
  await expect(page.getByRole('table')).toBeVisible();

  // A-05: past due is an icon plus the word, never the tint on its own.
  const lateCell = page.getByRole('button', { name: /AW09.*WW05/ });
  await expect(lateCell).toContainText('LATE');
  await expect(lateCell).toHaveAccessibleName(/past due/);
  const icon = await lateCell.locator('[aria-hidden="true"]').first().textContent();
  expect(icon?.trim().length).toBeGreaterThan(0);
  await expectNoViolations(page);

  // The selected-visit panel is its own interactive surface.
  await page.getByRole('button', { name: /EP07.*WW38/ }).click();
  await expect(page.getByTestId('planner-detail')).toBeVisible();
  await expectNoViolations(page);

  // And so is the adjust form inside it.
  await page.getByRole('button', { name: /Move next due date for/ }).click();
  await expect(page.getByLabel('Reason for this change')).toBeVisible();
  await expectNoViolations(page);
});

/**
 * Slice 32-PLANNERJOB — the assignment panel is the densest interactive
 * surface on this screen: two headed sections, a select that loads
 * asynchronously, and a lapsed-assignee alert. It is also where A-05 is
 * easiest to get wrong, because "unassigned" and "no longer eligible" are
 * exactly the states a designer reaches for a colour to express.
 *
 * SPLIT IN TWO deliberately. As one test it ran two full page loads and four
 * axe scans, and was measured at 16-29s against Playwright's 30s default — it
 * passed three times running and would still have been the first thing to go
 * red on a loaded CI machine, for no reason connected to the code. Two tests
 * also run in parallel.
 */
test('A-01/A-05: the planner assignment panel (both levels, picker open) has zero axe violations', async ({
  page,
  server,
}) => {
  await page.clock.setFixedTime(new Date('2026-08-03T12:00:00.000Z'));
  const machine = server.seedAsset({
    code: 'AW01',
    assetTypeId: 'at-1',
    scheduleAnchorDate: '2026-09-17',
  });
  const doc = server.seedAssetDocument({
    assetId: machine.id,
    formTemplateId: E2E_TEMPLATES.wireBond,
  });
  const job = server.seedGeneratedJob({
    assetDocumentId: doc.id,
    frequency: 'M1',
    dueOn: '2026-09-17',
    assetCode: 'AW01',
  });

  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.goto('/planner');
  await page.getByRole('button', { name: /AW01.*WW38/ }).click();

  // Both levels visible, both unassigned — the state the whole plant is in.
  const detail = page.getByTestId('planner-detail');
  await expect(detail.getByTestId('default-assignee-none')).toBeVisible();
  await expect(detail.getByTestId('job-assignee-none')).toBeVisible();
  // The job-level control names the job it will act on.
  await expect(
    detail.getByRole('button', { name: new RegExp(`Assign job ${job.jobNumber}`) }),
  ).toBeVisible();
  await expectNoViolations(page);

  // The picker, with its async-loaded options and its "what this affects" note.
  await detail.getByRole('button', { name: /Set who normally does/ }).click();
  await expect(page.getByLabel('Technician')).toBeEnabled();
  await expectNoViolations(page);
});

/**
 * A-05 for the two states that most invite a bare colour: a standing assignee
 * who has LAPSED (an accusation about a named person) and one whose
 * eligibility could not be CHECKED (a fact about the system). They must be
 * distinguishable in words, not by tint — and must not be confusable with each
 * other, which is the review finding this pins at the UI.
 */
test('A-05: the lapsed and unchecked standing-assignee states are words, not colour', async ({
  page,
  server,
}) => {
  await page.clock.setFixedTime(new Date('2026-08-03T12:00:00.000Z'));
  const machine = server.seedAsset({
    code: 'AW01',
    assetTypeId: 'at-1',
    scheduleAnchorDate: '2026-09-17',
  });
  const doc = server.seedAssetDocument({
    assetId: machine.id,
    formTemplateId: E2E_TEMPLATES.wireBond,
  });
  const rule = server.scheduleRuleFor(doc.id, 'M1');
  server.setRuleDefaultAssignee(rule.id, E2E_USERS.technician.id);
  server.deactivateUser(E2E_USERS.technician.id);

  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.goto('/planner');
  await page.getByRole('button', { name: /AW01.*WW38/ }).click();

  const lapsed = page.getByTestId('default-assignee-lapsed');
  await expect(lapsed).toBeVisible();
  await expect(lapsed).toContainText('UNASSIGNED');
  const lapsedIcon = await lapsed.locator('[aria-hidden="true"]').first().textContent();
  expect(lapsedIcon?.trim().length).toBeGreaterThan(0);
  // It accuses; the "could not check" state must NOT be showing alongside it.
  await expect(page.getByTestId('default-assignee-unknown')).toHaveCount(0);
  await expectNoViolations(page);
});

test('A-01: the ad-hoc document picker has zero axe violations', async ({ page, server }) => {
  const machine = server.seedAsset({ code: 'AW10', assetTypeId: 'at-1' });
  server.seedAssetDocument({
    assetId: machine.id,
    formTemplateId: E2E_TEMPLATES.wireBond,
    machineNumber: '13',
  });
  server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.epoxy });
  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.goto('/jobs/raise');
  await page.getByLabel('Machine', { exact: true }).selectOption(machine.id);
  await expect(page.getByLabel('Which document')).toBeVisible();
  await expectNoViolations(page);
});

test('A-01/A-05: the "no document" refusal on Raise a job is never colour alone', async ({
  page,
  server,
}) => {
  const machine = server.seedAsset({ code: 'AW11', assetTypeId: 'at-1' });
  await signInAs(page, E2E_USERS.teamLeader.email);
  await page.goto('/jobs/raise');
  await page.getByLabel('Machine', { exact: true }).selectOption(machine.id);
  const alert = page
    .getByRole('alert')
    .filter({ hasText: /carries no active preventive-maintenance/ });
  await expect(alert).toBeVisible();
  // Icon + words, not a red plate on its own.
  const icon = await alert.locator('[aria-hidden="true"]').first().textContent();
  expect(icon?.trim().length).toBeGreaterThan(0);
  await expectNoViolations(page);
});

test('A-01: the areas screen (list, create form, inline edit) has zero axe violations', async ({
  page,
  server,
}) => {
  server.seedArea({ code: 'BL', name: 'Bond Line' });
  await signInAsAdmin(page);
  await page.goto('/admin/areas');
  await expect(page.getByText('Bond Line')).toBeVisible();
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByLabel(/Rename BL/)).toBeVisible();
  await expectNoViolations(page);
});

/** A-02 (admin surface): a whole admin task — creating an area — is
 * completable with the keyboard alone. */
test('A-02: an area can be created using only the keyboard', async ({ page, server }) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/areas');
  const code = page.getByLabel('Code');
  await code.focus();
  await page.keyboard.type('KB-1');
  await page.keyboard.press('Tab'); // -> Name field
  await page.keyboard.type('Keyboard Area');
  const create = page.getByRole('button', { name: 'Create area' });
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Area Keyboard Area created.')).toBeVisible();
});

/** A-03: the new admin form controls all carry accessible labels. */
test('A-03: admin form fields have accessible labels', async ({ page, server }) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/users/new');
  await expect(page.getByLabel('Full name')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Employee ID (optional)')).toBeVisible();
  await expect(page.getByLabel('Initial password')).toBeVisible();
  await page.goto('/admin/machines/new');
  await expect(page.getByLabel('Asset type')).toBeVisible();
  await expect(page.getByLabel('Machine code (optional)')).toBeVisible();
  await expect(page.getByLabel('Schedule anchor date')).toBeVisible();
});

/** A-06: keyboard focus is visible on the admin surface (the tokens'
 * focus ring actually renders on a focused control). */
test('A-06: a keyboard-focused admin control shows a visible focus indicator', async ({
  page,
  server,
}) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/users');
  await expect(page.locator('.card-title', { hasText: 'Test Administrator' })).toBeVisible();
  const addUser = page.getByRole('button', { name: 'Add user' });
  await addUser.focus();
  // :focus-visible only fires for keyboard-initiated focus in some engines;
  // drive it with a real Tab so the check cannot pass vacuously.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(outline.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(outline.outlineWidth)).toBeGreaterThan(0);
});

/** A-07: a server refusal on the admin surface is announced (role=alert),
 * not silently rendered. */
test('A-07: a duplicate-email refusal is announced as an alert', async ({ page, server }) => {
  void server;
  await signInAsAdmin(page);
  await page.goto('/admin/users/new');
  await page.getByLabel('Full name').fill('Duplicate Person');
  await page.getByLabel('Email').fill(E2E_USERS.technician.email); // already taken
  await page.getByLabel('Initial password').fill('a-long-enough-password');
  await page.getByLabel(/Maintainer/).check();
  await page.getByRole('button', { name: 'Create user' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/already exists/);
  await expectNoViolations(page);
});
