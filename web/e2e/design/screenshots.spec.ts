import { test, type Browser, type Page } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from '../support/fake-server';
import { signInAs, drawSignature, DEFAULT_JOB } from '../support/fixtures';
import { currentTotpCode } from '../support/totp';

/**
 * Slice 14-DESIGN §5 — the visual evidence set. Not a test suite in the
 * assertion sense: it drives every redesigned screen through the real UI
 * against the fake server and captures what the owner reviews, at all three
 * supported breakpoints, into web/design-screenshots/ (committed).
 *
 * Run: npx playwright test --project=design
 * CI never invokes this project (jobs run offline/e2e/a11y by name).
 */

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

const OVERDUE_JOB: SeedJob = {
  id: 'job-shot-2',
  jobNumber: 'PM-2026-000388',
  assetCode: 'AW11',
  frequency: 'M1',
  dueOn: '2026-07-20',
  overdue: true,
  items: [{ id: 'item-shot-2-1', itemNo: 1, instruction: 'Grease spindle bearing' }],
};

// Seeded with real recorded results (review D-6): a genuine SUBMITTED record
// always carries them, so the review screenshots must show the actual
// DONE / NOT_DONE vocabulary — including a remark — not an empty record.
const REVIEW_JOB: SeedJob = {
  id: 'job-shot-3',
  jobNumber: 'PM-2026-000512',
  assetCode: 'AW05',
  frequency: 'M3',
  dueOn: '2026-08-01',
  status: 'SUBMITTED',
  submittedBy: E2E_USERS.technician.id,
  submittedAt: new Date('2026-07-26T09:12:00Z').toISOString(),
  currentStageOrdinal: 1,
  items: [
    { id: 'item-shot-3-1', itemNo: 1, instruction: 'Check heater block temperature' },
    { id: 'item-shot-3-2', itemNo: 2, instruction: 'Inspect wire bond capillary' },
  ],
  itemResults: [
    { templateItemId: 'item-shot-3-1', status: 'DONE' },
    {
      templateItemId: 'item-shot-3-2',
      status: 'NOT_DONE',
      remark: 'Capillary worn — replacement part on order.',
    },
  ],
};

async function shot(
  page: Page,
  name: string,
  width: number,
  opts: { keepScroll?: boolean } = {},
): Promise<void> {
  // Frame from the top unless a test deliberately framed a lower region —
  // review D-6 caught shots captured wherever the flow left the scroll.
  if (!opts.keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250); // let fonts/layout settle
  await page.screenshot({
    path: `design-screenshots/${name}-${width}.png`,
    animations: 'disabled',
  });
}

async function withFreshPage(
  browser: Browser,
  viewport: { width: number; height: number },
  seed: (server: FakeServer) => void,
  run: (page: Page, server: FakeServer) => Promise<void>,
): Promise<void> {
  const server = new FakeServer();
  seed(server);
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await server.install(page);
  await run(page, server);
  await context.close();
}

for (const vp of VIEWPORTS) {
  const w = vp.width;

  test(`sign-in family @${w}`, async ({ browser }) => {
    await withFreshPage(
      browser,
      vp,
      () => undefined,
      async (page) => {
        await page.goto('/sign-in');
        await page.getByLabel('Email').waitFor();
        await shot(page, '01-sign-in', w);
      },
    );

    // TOTP + recovery steps (already-enrolled admin).
    await withFreshPage(
      browser,
      vp,
      (server) => {
        server.enableMfa();
        server.seedMfaEnrolment(E2E_USERS.admin.id);
        server.seedRecoveryCodes(E2E_USERS.admin.id);
      },
      async (page) => {
        await page.goto('/sign-in');
        await page.getByLabel('Email').fill(E2E_USERS.admin.email);
        await page.getByLabel('Password').fill(E2E_PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('heading', { name: 'Enter your 6-digit code' }).waitFor();
        await shot(page, '02-sign-in-totp', w);
        await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
        await page.getByRole('heading', { name: 'Use a recovery code' }).waitFor();
        await shot(page, '03-sign-in-recovery', w);
      },
    );

    // Enrolment (QR + manual key) and the one-time recovery-codes screen.
    await withFreshPage(
      browser,
      vp,
      (server) => server.enableMfa(),
      async (page) => {
        await page.goto('/sign-in');
        await page.getByLabel('Email').fill(E2E_USERS.admin.email);
        await page.getByLabel('Password').fill(E2E_PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('heading', { name: 'Set up your authenticator' }).waitFor();
        await page.getByRole('img', { name: /QR code/i }).waitFor();
        await shot(page, '04-mfa-enrolment', w);
        const secret = (await page.locator('#mfa-manual-entry code').innerText()).trim();
        await page.locator('#enrol-totp-code').fill(currentTotpCode(secret));
        await page.getByRole('button', { name: 'Confirm and finish signing in' }).click();
        await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
        await shot(page, '05-recovery-codes', w);
      },
    );
  });

  test(`technician flow @${w}`, async ({ browser }) => {
    await withFreshPage(
      browser,
      vp,
      (server) => {
        server.seedJob(DEFAULT_JOB);
        server.seedJob(OVERDUE_JOB);
      },
      async (page) => {
        await signInAs(page, E2E_USERS.technician.email);
        await page.getByText(DEFAULT_JOB.jobNumber).waitFor();
        await shot(page, '06-job-list', w);

        // The crown jewel, mid-fill: one item recorded, one still open.
        await page.getByText(DEFAULT_JOB.jobNumber).click();
        await page.getByRole('heading', { name: DEFAULT_JOB.jobNumber }).waitFor();
        await shot(page, '07-record-capture', w);
        await page.getByRole('button', { name: 'Done', exact: true }).first().click();
        await page.waitForTimeout(300);
        await shot(page, '08-record-capture-midfill', w);

        // Menu (technician: no admin entry, queue via menu).
        await page.getByRole('button', { name: 'Menu' }).click();
        await page.getByRole('heading', { name: 'Menu' }).waitFor();
        await shot(page, '13-menu-technician', w);

        // Voluntary change-password.
        await page.getByRole('button', { name: 'Change password' }).click();
        await page.getByRole('heading', { name: 'Change your password' }).waitFor();
        await shot(page, '14-change-password', w);
      },
    );

    // Forced change-password gate (shell-less by design).
    await withFreshPage(
      browser,
      vp,
      (server) => {
        server.seedJob(DEFAULT_JOB);
        server.seedMustChangePassword(E2E_USERS.technician.id);
      },
      async (page) => {
        await page.goto('/sign-in');
        await page.getByLabel('Email').fill(E2E_USERS.technician.email);
        await page.getByLabel('Password').fill(E2E_PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.getByRole('heading', { name: 'Change your password' }).waitFor();
        await shot(page, '15-change-password-forced', w);
      },
    );
  });

  test(`verifier flow @${w}`, async ({ browser }) => {
    await withFreshPage(
      browser,
      vp,
      (server) => server.seedJob(REVIEW_JOB),
      async (page) => {
        await signInAs(page, E2E_USERS.teamLeader.email);
        await page.getByRole('button', { name: 'Verifier queue' }).click();
        await page.getByText(REVIEW_JOB.jobNumber).waitFor();
        await shot(page, '09-verifier-queue', w);

        await page.getByText(REVIEW_JOB.jobNumber).click();
        await page.getByRole('heading', { name: REVIEW_JOB.jobNumber }).waitFor();
        await page.getByText('DONE', { exact: true }).waitFor();
        await shot(page, '10-record-review', w);

        await page.getByRole('button', { name: 'Verify' }).click();
        await drawSignature(page);
        await page.locator('.signature-pad-canvas').scrollIntoViewIfNeeded();
        await shot(page, '11-record-review-sign', w, { keepScroll: true });
      },
    );

    // Delegations with one active grant created through the real form.
    await withFreshPage(
      browser,
      vp,
      () => undefined,
      async (page) => {
        await signInAs(page, E2E_USERS.teamLeader.email);
        await page.getByRole('button', { name: 'Verifier queue' }).click();
        await page.getByRole('button', { name: 'Delegations' }).click();
        await page.getByRole('heading', { name: 'Delegations', exact: true }).waitFor();
        const pad = (n: number) => String(n).padStart(2, '0');
        const local = (d: Date) =>
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        await page.getByLabel('Delegator user ID').fill(E2E_USERS.teamLeader.id);
        await page.getByLabel('Delegate user ID').fill(E2E_USERS.delegate.id);
        await page.getByLabel('Valid from').fill(local(new Date(Date.now() - 3_600_000)));
        await page.getByLabel('Valid to').fill(local(new Date(Date.now() + 86_400_000)));
        await page.getByLabel(/reason/i).fill('Out sick this week');
        await page.getByRole('button', { name: 'Create delegation' }).click();
        await page.getByText('Active').waitFor();
        await shot(page, '12-delegations', w);
      },
    );
  });

  test(`admin flow @${w}`, async ({ browser }) => {
    await withFreshPage(
      browser,
      vp,
      (server) => server.seedJob(DEFAULT_JOB),
      async (page) => {
        await signInAs(page, E2E_USERS.admin.email);
        await page.getByRole('button', { name: 'Menu' }).click();
        await page.getByRole('heading', { name: 'Menu' }).waitFor();
        await shot(page, '16-menu-admin', w);

        await page.getByRole('button', { name: /Reset a user/i }).click();
        await page.getByRole('heading', { name: /Reset a user.s authenticator/i }).waitFor();
        await page.locator('#mfa-reset-user-id').fill(E2E_USERS.engineer.id);
        await page.getByRole('button', { name: /Reset this user/i }).click();
        await page.getByRole('alert').waitFor();
        // Frame the destructive confirmation itself — the point of the shot
        // (review D-6 caught the buttons clipped under the tab bar at 375).
        await page.locator('.dialog-actions').scrollIntoViewIfNeeded();
        await shot(page, '17-admin-mfa-reset-confirm', w, { keepScroll: true });
      },
    );
  });
}
