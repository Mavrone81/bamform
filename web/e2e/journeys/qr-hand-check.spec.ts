import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { FakeServer, E2E_USERS, E2E_PASSWORD } from '../support/fake-server';
import { currentTotpCode } from '../support/totp';

/**
 * NOT an assertion of correctness — a hand-verification aid, and the one gap
 * in this slice that only a human can close (brief §10).
 *
 * Everything automated here proves the encoder emits a well-formed QR symbol
 * identical, module for module, to an independent implementation's
 * (`src/lib/qrcode.test.ts`). None of it can prove that Google Authenticator,
 * Microsoft Authenticator or 1Password ACCEPT it, because nothing in this
 * repository owns a phone. This captures the symbol the REAL enrolment screen
 * renders, in a real browser, at a scannable size, together with the secret
 * and the code that secret should be producing:
 *
 *     QR_HAND_CHECK=1 npx playwright test --project=e2e -g "QR hand-check" --config=web/playwright.config.ts
 *
 * It prints the artifact paths. Open the PNG at 100%, scan it with a real
 * authenticator app, and check that
 *   (a) the entry is named "BamForm (admin@bevorasg.com)", and
 *   (b) the 6-digit code it shows matches the one printed in the .txt beside
 *       it (recompute with `currentTotpCode(secret)` if the window has moved).
 * If both hold, our `otpauth://` URI and our QR encoder are both right in the
 * only way that ultimately matters.
 *
 * Skipped unless `QR_HAND_CHECK` is set, so CI never runs it.
 */
test.skip(!process.env.QR_HAND_CHECK, 'hand-verification aid — set QR_HAND_CHECK=1 to produce it');

test('QR hand-check: capture the real enrolment QR for a human to scan', async ({
  page,
}, testInfo) => {
  const server = new FakeServer();
  server.enableMfa();
  await server.install(page);

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(E2E_USERS.admin.email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const qr = page.getByRole('img', { name: /QR code/i });
  await qr.scrollIntoViewIfNeeded();
  await expect(qr).toBeVisible();

  const manual = page.locator('#mfa-manual-entry');
  const secret = (await manual.locator('code').innerText()).trim();

  const imagePath = testInfo.outputPath('qr-hand-check.png');
  await qr.screenshot({ path: imagePath, scale: 'device' });

  const notesPath = testInfo.outputPath('qr-hand-check.txt');
  writeFileSync(
    notesPath,
    [
      'BamForm QR hand-check',
      '',
      `Expected authenticator entry: BamForm (${E2E_USERS.admin.email})`,
      `Base32 secret:                ${secret}`,
      `Code at capture time:         ${currentTotpCode(secret)}`,
      'Parameters:                   SHA1, 6 digits, 30 s period',
      '',
      'Scan the PNG beside this file. The app should create the entry above',
      'and show a code matching the one here (within the same 30 s window).',
      '',
    ].join('\n'),
  );

  console.log(`\nQR hand-check artifacts:\n  ${imagePath}\n  ${notesPath}\n`);
});
