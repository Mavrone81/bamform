import { test, expect, type Page, type Browser } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from '../support/fake-server';
import { signInAs } from '../support/fixtures';

/**
 * E-02: a verifier opens the queue, reviews a submitted record, signs on
 * the drawn-signature pad, and the record becomes VERIFIED — two-stage
 * (ADR-011): stage 1 needs a TEAM_LEADER, stage 2 needs an ENGINEER, and
 * only advances to ARCHIVED once BOTH have signed. Also exercises the
 * step-up-before-signing flow (PR-API-07): the first verify attempt is
 * always rejected 403 step-up-required by the fake server (no "login
 * satisfies it" shortcut — see fake-server.ts's `stepUpValidUserIds` doc),
 * so this test genuinely drives a wrong-password rejection AND the
 * successful retry, not a canned success path.
 */

const JOB: SeedJob = {
  id: 'job-e02',
  jobNumber: 'PM-2026-000501',
  assetCode: 'AW05',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-e02-1', itemNo: 1, instruction: 'Check heater block temperature' }],
  status: 'SUBMITTED',
  submittedBy: E2E_USERS.technician.id,
  submittedAt: new Date(Date.now() - 3_600_000).toISOString(),
  currentStageOrdinal: 1,
};

/** Draws a short, unmistakably non-blank stroke across the signature pad
 * using real mouse-driven pointer events (Chromium dispatches genuine
 * pointerdown/pointermove/pointerup for mouse input, exercising the SAME
 * code path a stylus would) — this is a real signature captured by the
 * real canvas, not a stub. */
async function drawSignature(page: Page): Promise<void> {
  const canvas = page.locator('.signature-pad-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('signature pad canvas has no bounding box');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.25, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
}

async function verifyWithStepUp(
  page: Page,
  opts: { wrongPasswordFirst?: boolean } = {},
): Promise<void> {
  await page.getByRole('button', { name: 'Verify' }).click();
  await drawSignature(page);
  await page.getByRole('button', { name: 'Done' }).click();

  await expect(page.getByRole('heading', { name: 'Re-enter your password to sign' })).toBeVisible();

  if (opts.wrongPasswordFirst) {
    await page.locator('#step-up-password').fill('definitely-the-wrong-password');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('alert')).toHaveText(/incorrect password/i);
  }

  await page.locator('#step-up-password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

async function openFromQueue(page: Page, jobNumber: string): Promise<void> {
  await page.getByRole('button', { name: 'Verifier queue' }).click();
  await expect(page.getByRole('heading', { name: 'Verifier queue' })).toBeVisible();
  await page.getByText(jobNumber).click();
  await expect(page.getByRole('heading', { name: jobNumber })).toBeVisible();
}

async function withActor(
  browser: Browser,
  server: FakeServer,
  viewport: { width: number; height: number },
  email: string,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await server.install(page);
  await signInAs(page, email);
  await run(page);
  await context.close();
}

test('E-02: two-stage verify — TEAM_LEADER then ENGINEER sign, record VERIFIED then ARCHIVED', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  const viewport = testInfo.project.use.viewport ?? { width: 1280, height: 900 };

  // Stage 1: TEAM_LEADER opens the queue, reviews, and signs. First attempt
  // is rejected for step-up; a wrong password is rejected too before the
  // correct one succeeds.
  await withActor(browser, server, viewport, E2E_USERS.teamLeader.email, async (page) => {
    await openFromQueue(page, JOB.jobNumber);
    await expect(page.getByText(/stage 1 of 2/i)).toBeVisible();
    await verifyWithStepUp(page, { wrongPasswordFirst: true });
    await expect(page.getByText('Verified. Awaiting the next approval stage.')).toBeVisible();
  });

  // Stage 2: a DIFFERENT actor (ENGINEER), in a separate browser context
  // (separate cookies/tokens — mirrors O-13's two-device pattern), now sees
  // the SAME job in their own queue (stage advanced, role requirement
  // changed) and completes the second signature.
  await withActor(browser, server, viewport, E2E_USERS.engineer.email, async (page) => {
    await openFromQueue(page, JOB.jobNumber);
    await expect(page.getByText(/stage 2 of 2/i)).toBeVisible();
    await verifyWithStepUp(page);
    await expect(page.getByText('Verified and archived — approval complete.')).toBeVisible();
    await expect(page.getByText('ARCHIVED', { exact: true })).toBeVisible();

    // Both signatures are recorded in the approval history, in order.
    const steps = page.locator('.approval-step');
    await expect(steps).toHaveCount(2); // stage-1 VERIFIED, then stage-2 VERIFIED
    await expect(steps.nth(0)).toContainText('VERIFIED');
    await expect(steps.nth(1)).toContainText('VERIFIED');
  });
});
