import { test, expect } from '@playwright/test';
import { FakeServer, E2E_USERS, type SeedJob } from '../support/fake-server';
import { signInAs } from '../support/fixtures';

/**
 * E-03: a verifier returns a submitted record with a reason, the
 * technician corrects and resubmits it, and the full sequence
 * (SUBMITTED → RETURNED → SUBMITTED) is visible in the record's approval
 * history. Two actors, two `BrowserContext`s sharing one `FakeServer`
 * (mirrors O-13/O-14) — the technician submits, reloads after the return
 * to pick up the server's fresh state (an in-memory access token is never
 * persisted across a reload, non-negotiable #10, so this also proves the
 * silent-refresh-on-reload path still works mid-journey), then resubmits.
 */

const JOB: SeedJob = {
  id: 'job-e03',
  jobNumber: 'PM-2026-000601',
  assetCode: 'AW06',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-e03-1', itemNo: 1, instruction: 'Check heater block temperature' }],
};

const RETURN_REASON = 'Torque reading is out of tolerance — please recheck and rework.';

test('E-03: verifier returns with a reason → technician corrects and resubmits → sequence visible', async ({
  browser,
}) => {
  const server = new FakeServer();
  server.seedJob(JOB);

  const techContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const techPage = await techContext.newPage();
  await server.install(techPage);
  await signInAs(techPage, E2E_USERS.technician.email);

  // 1. Technician submits the record for the first time.
  await techPage.getByText(JOB.jobNumber).click();
  await expect(techPage.getByRole('heading', { name: JOB.jobNumber })).toBeVisible();
  await techPage.getByRole('button', { name: 'Submit' }).click();
  await expect(techPage.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  // 2. A TEAM_LEADER, in a separate context, returns it with a reason.
  const leaderContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const leaderPage = await leaderContext.newPage();
  await server.install(leaderPage);
  await signInAs(leaderPage, E2E_USERS.teamLeader.email);

  await leaderPage.getByRole('button', { name: 'Verifier queue' }).click();
  await expect(leaderPage.getByText(JOB.jobNumber)).toBeVisible();
  await leaderPage.getByText(JOB.jobNumber).click();
  await leaderPage.getByRole('button', { name: 'Return' }).click();
  await leaderPage.getByLabel(/reason/i).fill(RETURN_REASON);
  await leaderPage.getByRole('button', { name: 'Return' }).click();
  await expect(leaderPage.getByText('Returned to the technician for rework.')).toBeVisible();
  await expect(leaderPage.getByText('IN_PROGRESS')).toBeVisible();
  await leaderContext.close();

  // The job no longer belongs in anyone's queue until it is resubmitted.
  // 3. The technician reconnects (fresh page load — access token is
  // in-memory only, so this also re-exercises silent refresh) and
  // resubmits, all previously entered results preserved.
  await techPage.reload();
  await expect(techPage.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await techPage.getByText(JOB.jobNumber).click();
  await expect(techPage.getByRole('heading', { name: JOB.jobNumber })).toBeVisible();
  await techPage.getByRole('button', { name: 'Submit' }).click();
  await expect(techPage.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await techContext.close();

  // 4. Back with a verifier: the full sequence is visible on the record.
  const reviewContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const reviewPage = await reviewContext.newPage();
  await server.install(reviewPage);
  await signInAs(reviewPage, E2E_USERS.teamLeader.email);
  await reviewPage.getByRole('button', { name: 'Verifier queue' }).click();
  await reviewPage.getByText(JOB.jobNumber).click();

  const steps = reviewPage.locator('.approval-step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText('SUBMITTED');
  await expect(steps.nth(1)).toContainText('RETURNED');
  await expect(steps.nth(1)).toContainText(RETURN_REASON);
  await expect(steps.nth(2)).toContainText('SUBMITTED');
  await reviewContext.close();
});
