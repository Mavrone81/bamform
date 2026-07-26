import { test, expect, type Browser, type Page } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from '../support/fake-server';
import {
  currentTotpCode,
  currentTotpStep,
  totpCodeForStep,
  wrongTotpCodeFor,
} from '../support/totp';

/**
 * E-05: signing in with TOTP, the flow that `MFA_ENABLED=true` turns on.
 *
 * The account used is an ADMIN, deliberately: ADMIN is in the default
 * `MFA_REQUIRED_ROLES`, and production's only account holds it — this is
 * precisely the login that would have locked Samuel out had slice 13-MFA
 * shipped its flag enabled without these screens.
 *
 * The fake server is not a rubber stamp (see `support/totp.ts`). It computes
 * codes with a real RFC 6238 implementation, applies the ±1-step window and
 * the `mfa_last_used_step` replay guard, burns a challenge token on
 * redemption, and marks a recovery code used rather than deleting it. Every
 * rejection below is the server saying no, not the UI declining to ask.
 */

const JOB: SeedJob = {
  id: 'job-e05',
  jobNumber: 'PM-2026-000505',
  assetCode: 'AW07',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-e05-1', itemNo: 1, instruction: 'Check heater block temperature' }],
};

function viewportFrom(testInfo: {
  project: { use: { viewport?: { width: number; height: number } | null } };
}) {
  // CI job 8 runs this project three times (375 / 768 / 1280) via
  // VIEWPORT_WIDTH. Hardcoding 375 in `browser.newContext` here is what
  // reddened main in slice 11b: the matrix silently tested one width thrice.
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

/** Password step only — the point at which the server answers with a
 * challenge instead of a session. */
async function submitPassword(page: Page, email: string, password = E2E_PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function fillAndSubmit(page: Page, selector: string, value: string, button: string) {
  const field = page.locator(selector);
  await field.scrollIntoViewIfNeeded();
  await field.fill(value);
  const submit = page.getByRole('button', { name: button, exact: true });
  await submit.scrollIntoViewIfNeeded();
  await submit.click();
}

test('E-05: an enrolled ADMIN completes a two-step sign-in; a wrong code is rejected first', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.enableMfa();
  const secret = server.seedMfaEnrolment(E2E_USERS.admin.id);

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    await submitPassword(page, E2E_USERS.admin.email);

    // The password was accepted but the login is NOT finished: no jobs yet.
    await expect(page.getByRole('heading', { name: 'Enter your 6-digit code' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toHaveCount(0);

    // A wrong code is refused by the SERVER — the six digits below are a
    // valid-looking code that simply is not this secret's.
    const wrongCode = wrongTotpCodeFor(secret);
    await fillAndSubmit(page, '#totp-code', wrongCode, 'Verify');
    await expect(page.getByRole('alert')).toContainText(/was not accepted/i);
    expect(server.rejectedTotpCodes).toContain(wrongCode);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toHaveCount(0);

    // The right one, computed from the secret the server issued, exactly as
    // the user's phone would.
    await fillAndSubmit(page, '#totp-code', currentTotpCode(secret), 'Verify');
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });
});

test('E-05b: a recovery code signs the user in once, and only once', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.enableMfa();
  server.seedMfaEnrolment(E2E_USERS.admin.id);
  const codes = server.seedRecoveryCodes(E2E_USERS.admin.id);
  const viewport = viewportFrom(testInfo);

  // Device 1: the phone is lost, so the user falls back to a recovery code.
  await withPage(browser, server, viewport, async (page) => {
    await submitPassword(page, E2E_USERS.admin.email);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await expect(page.getByRole('heading', { name: 'Use a recovery code' })).toBeVisible();
    await fillAndSubmit(page, '#recovery-code', codes[0], 'Use recovery code');
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });

  // Device 2: a fresh context (its own cookies and its own challenge). The
  // SAME code must now fail — the server marked it used, it did not delete it
  // and it did not forget.
  await withPage(browser, server, viewport, async (page) => {
    await submitPassword(page, E2E_USERS.admin.email);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await fillAndSubmit(page, '#recovery-code', codes[0], 'Use recovery code');
    await expect(page.getByRole('alert')).toContainText(/only once/i);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toHaveCount(0);

    // A different, unused code still works.
    await fillAndSubmit(page, '#recovery-code', codes[1], 'Use recovery code');
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });
});

test('E-05c: MAINTAINER is exempt — the technician still signs in in one step with MFA on', async ({
  browser,
}, testInfo) => {
  // SEC RS-3/SO-3: full MFA on gloved hands in a cleanroom would push people
  // back to paper. Turning the flag on must not change the shop floor's flow.
  const server = new FakeServer();
  server.seedJob(JOB);
  server.enableMfa();

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    await submitPassword(page, E2E_USERS.technician.email);
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  });
});

/**
 * E-05d — a probe of the FAKE SERVER itself, not of the UI, and labelled as
 * such. Some of the properties the UI depends on cannot be driven through the
 * UI at all: the challenge token is held in memory and never exposed to a
 * page script by the app, so there is no way to click a replay. These raw
 * requests go through the same `page.route` interception the app's own calls
 * do, and exist so "the fake genuinely rejects a replayed challenge token"
 * is an assertion rather than a claim in a comment.
 */
test('E-05d: the fake server genuinely enforces single-use challenge tokens and the replay guard', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  server.enableMfa();
  const secret = server.seedMfaEnrolment(E2E_USERS.admin.id);

  await withPage(browser, server, viewportFrom(testInfo), async (page) => {
    await page.goto('/sign-in');

    const challenge = await page.evaluate(async (email) => {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
      });
      return (await res.json()) as { mfaRequired?: boolean; challengeToken?: string };
    }, E2E_USERS.admin.email);

    expect(challenge.mfaRequired).toBe(true);
    expect(challenge.challengeToken).toBeTruthy();

    const post = (path: string, body: unknown) =>
      page.evaluate(
        async ({ path: p, body: b }) => {
          const res = await fetch(p, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(b),
          });
          return res.status;
        },
        { path, body },
      );

    const token = challenge.challengeToken!;
    const step = currentTotpStep();

    // A wrong code: rejected, and the challenge SURVIVES (matching the api,
    // which only claims the token on a successful redemption).
    expect(
      await post('/api/v1/auth/mfa/verify', {
        challengeToken: token,
        totpCode: wrongTotpCodeFor(secret),
      }),
    ).toBe(401);

    // The right code: accepted exactly once.
    const code = totpCodeForStep(secret, step);
    expect(await post('/api/v1/auth/mfa/verify', { challengeToken: token, totpCode: code })).toBe(
      200,
    );

    // Replaying the identical request — same token, same code — is refused.
    expect(await post('/api/v1/auth/mfa/verify', { challengeToken: token, totpCode: code })).toBe(
      401,
    );

    // And the RFC 6238 §5.2 replay guard holds independently of the token:
    // a brand-new challenge cannot redeem a code from a step already spent.
    const second = await page.evaluate(async (email) => {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
      });
      return (await res.json()) as { challengeToken: string };
    }, E2E_USERS.admin.email);

    expect(
      await post('/api/v1/auth/mfa/verify', {
        challengeToken: second.challengeToken,
        totpCode: code,
      }),
    ).toBe(401);

    // A code from the NEXT step is accepted on that same fresh challenge,
    // proving the rejection above was the replay guard and not a dead token.
    expect(
      await post('/api/v1/auth/mfa/verify', {
        challengeToken: second.challengeToken,
        totpCode: totpCodeForStep(secret, step + 1),
      }),
    ).toBe(200);
  });
});
