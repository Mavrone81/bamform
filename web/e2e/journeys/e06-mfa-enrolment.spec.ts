import { test, expect, type Browser, type Page } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from '../support/fake-server';
import { currentTotpCode, wrongTotpCodeFor } from '../support/totp';

/**
 * E-06: first-time TOTP enrolment, mid-login.
 *
 * This is the flow a real administrator meets the first time `MFA_ENABLED` is
 * switched on: the password is accepted, the login stops, and they cannot
 * proceed until they have scanned a QR and confirmed a code. Confirming also
 * completes the login and hands back the ten recovery codes, once.
 *
 * The QR itself is verified elsewhere (`src/lib/qrcode.test.ts` compares it
 * module-for-module with an independent encoder). What this journey proves is
 * that the URI reaching it is the one the server issued, that the manual key
 * is present as the text alternative, and that the user cannot walk past the
 * recovery codes without acknowledging them.
 */

const JOB: SeedJob = {
  id: 'job-e06',
  jobNumber: 'PM-2026-000506',
  assetCode: 'AW08',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-e06-1', itemNo: 1, instruction: 'Check heater block temperature' }],
};

function viewportFrom(testInfo: {
  project: { use: { viewport?: { width: number; height: number } | null } };
}) {
  // Read from the project, never hardcoded — CI job 8 runs 375/768/1280.
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

async function submitPassword(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function confirmCode(page: Page, code: string): Promise<void> {
  const field = page.locator('#enrol-totp-code');
  await field.scrollIntoViewIfNeeded();
  await field.fill(code);
  const submit = page.getByRole('button', { name: 'Confirm and finish signing in' });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
}

test('E-06: an unenrolled ADMIN scans, confirms, saves the recovery codes and lands signed in', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.enableMfa();

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    const enrolResponse = page.waitForResponse(
      (res) => res.url().includes('/auth/mfa/enrol') && !res.url().includes('confirm'),
    );
    await submitPassword(page, E2E_USERS.admin.email);

    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();

    // The URI this screen turns into a QR must be the shape the REAL api
    // emits, character for character — `api/src/auth/mfa/totp.ts`
    // #buildOtpauthUri encodes the issuer and the account name separately, so
    // the separator is a literal colon and only the `@` is escaped. The
    // hand-check artefact is the last gap before `MFA_ENABLED` can be turned
    // on, and it is worthless if it validates a URI production never produces
    // (review finding m1).
    const { otpauthUri } = (await (await enrolResponse).json()) as { otpauthUri: string };
    expect(otpauthUri).toMatch(
      /^otpauth:\/\/totp\/BamForm:admin%40bevorasg\.com\?secret=[A-Z2-7]+&issuer=BamForm&algorithm=SHA1&digits=6&period=30$/,
    );

    // The QR is a real, rendered symbol with an accessible name...
    const qr = page.getByRole('img', { name: /QR code/i });
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeVisible();
    // ...and it is described by the manual-entry key, which is the text
    // alternative for anyone who cannot use a camera (brief §5).
    const describedBy = await qr.getAttribute('aria-describedby');
    expect(describedBy).toBe('mfa-manual-entry');
    const manual = page.locator('#mfa-manual-entry');
    await expect(manual).toContainText(/setup key/i);
    await expect(manual).toContainText('SHA1');

    // The key on screen is the secret the server actually issued — an
    // authenticator typed up from it produces codes this server accepts,
    // which is exactly what the confirmation below then proves.
    const secret = (await manual.locator('code').innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    // A wrong code is refused, by the server.
    const wrong = wrongTotpCodeFor(secret);
    await confirmCode(page, wrong);
    await expect(page.getByRole('alert')).toContainText(/was not accepted/i);
    expect(server.rejectedTotpCodes).toContain(wrong);
    expect(server.isEnrolled(E2E_USERS.admin.id)).toBe(false);

    // The right code enrols the account AND completes the login.
    await confirmCode(page, currentTotpCode(secret));

    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    expect(server.isEnrolled(E2E_USERS.admin.id)).toBe(true);

    const codes = page.getByRole('list', { name: 'Recovery codes' }).locator('li');
    await expect(codes).toHaveCount(10);
    await expect(page.getByRole('alert')).toContainText(/shown once/i);

    // 13-UI-A review m5: Copy and Download are the ONLY mechanisms by which
    // a user saves credentials that can never be shown again — both are
    // exercised here for real, not assumed. The clipboard must end up
    // holding all ten codes, and the download must produce the named file.
    const codeTexts = await codes.allInnerTexts();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy codes' }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    for (const code of codeTexts) {
      expect(clipboard).toContain(code.trim());
    }

    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download codes' }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('bamform-recovery-codes.txt');

    // Nothing moves until the user says they have saved them. The Continue
    // button is the only way forward and it is disabled.
    const proceed = page.getByRole('button', { name: 'Continue' });
    await proceed.scrollIntoViewIfNeeded();
    await expect(proceed).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toHaveCount(0);

    const acknowledge = page.getByLabel(/saved these recovery codes/i);
    await acknowledge.scrollIntoViewIfNeeded();
    await acknowledge.check();
    await expect(proceed).toBeEnabled();
    await proceed.click();

    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });
});

test('E-06b: the codes are gone for good — signing in again never shows them', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.enableMfa();
  const viewport = viewportFrom(testInfo);
  let secret = '';

  await withPage(browser, server, viewport, async (page) => {
    await submitPassword(page, E2E_USERS.admin.email);
    const manual = page.locator('#mfa-manual-entry');
    await manual.scrollIntoViewIfNeeded();
    secret = (await manual.locator('code').innerText()).trim();
    await confirmCode(page, currentTotpCode(secret));
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    const acknowledge = page.getByLabel(/saved these recovery codes/i);
    await acknowledge.scrollIntoViewIfNeeded();
    await acknowledge.check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });

  // A second device, a second sign-in. The account is enrolled now, so the
  // server asks for a code rather than offering enrolment again — and there
  // is no screen anywhere that re-displays the codes.
  await withPage(browser, server, viewport, async (page) => {
    await submitPassword(page, E2E_USERS.admin.email);
    await expect(page.getByRole('heading', { name: 'Enter your 6-digit code' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toHaveCount(0);
  });
});
