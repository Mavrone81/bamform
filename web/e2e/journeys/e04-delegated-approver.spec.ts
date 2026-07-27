import { test, expect } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from '../support/fake-server';
import { signInAs, drawSignature } from '../support/fixtures';

/**
 * E-04: a delegated approver covers an absence — the TEAM_LEADER grants a
 * colleague (who otherwise holds no verifying role at all, see
 * fake-server.ts's `E2E_USERS.delegate` doc) delegated authority for a
 * time window, and that delegate acts on the leader's behalf within it.
 * The delegation itself is created through the real UI (Delegations
 * screen), not seeded directly, so the create-delegation form is
 * genuinely exercised, not just the queue/verify side of PR-076.
 */

const JOB: SeedJob = {
  id: 'job-e04',
  jobNumber: 'PM-2026-000701',
  assetCode: 'AW07',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-e04-1', itemNo: 1, instruction: 'Check heater block temperature' }],
  status: 'SUBMITTED',
  submittedBy: E2E_USERS.technician.id,
  submittedAt: new Date(Date.now() - 3_600_000).toISOString(),
  currentStageOrdinal: 1,
};

function toLocalDatetimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('E-04: a delegated approver covers an absence and acts on behalf of the delegator', async ({
  browser,
}, testInfo) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  const viewport = testInfo.project.use.viewport ?? { width: 375, height: 812 };

  // The absent TEAM_LEADER grants delegated authority to a colleague, for
  // a window that safely covers "now", through the real Delegations UI.
  const leaderContext = await browser.newContext({ viewport });
  const leaderPage = await leaderContext.newPage();
  await server.install(leaderPage);
  await signInAs(leaderPage, E2E_USERS.teamLeader.email);

  await leaderPage.getByRole('button', { name: 'Verifier queue' }).click();
  await leaderPage.getByRole('button', { name: 'Delegations' }).click();
  await expect(leaderPage.getByRole('heading', { name: 'Delegations', exact: true })).toBeVisible();

  const validFrom = new Date(Date.now() - 60 * 60_000);
  const validTo = new Date(Date.now() + 24 * 60 * 60_000);
  await leaderPage.getByLabel('Delegator user ID').fill(E2E_USERS.teamLeader.id);
  await leaderPage.getByLabel('Delegate user ID').fill(E2E_USERS.delegate.id);
  await leaderPage.getByLabel('Valid from').fill(toLocalDatetimeInputValue(validFrom));
  await leaderPage.getByLabel('Valid to').fill(toLocalDatetimeInputValue(validTo));
  await leaderPage.getByLabel(/reason/i).fill('Out sick this week');
  await leaderPage.getByRole('button', { name: 'Create delegation' }).click();

  await expect(leaderPage.getByText(/Test Team Leader.*Test Delegate/)).toBeVisible();
  await expect(leaderPage.getByText('Active')).toBeVisible();
  await leaderContext.close();

  // The delegate — who holds no TEAM_LEADER/ENGINEER role of their own —
  // now sees the leader's queue entry, marked as acting on their behalf.
  const delegateContext = await browser.newContext({ viewport });
  const delegatePage = await delegateContext.newPage();
  await server.install(delegatePage);
  await signInAs(delegatePage, E2E_USERS.delegate.email);

  // Slice 14-DESIGN: the delegate holds no verifying role, so the nav shell
  // offers no dedicated Queue tab — the queue is reached via the Menu tab
  // (still two taps from anywhere, and still the same server-side rules).
  await delegatePage.getByRole('button', { name: 'Menu' }).click();
  await delegatePage.getByRole('button', { name: 'Verifier queue' }).click();
  await expect(delegatePage.getByText(JOB.jobNumber)).toBeVisible();
  await expect(delegatePage.getByText(/on behalf of delegator/i)).toBeVisible();

  await delegatePage.getByText(JOB.jobNumber).click();
  await expect(delegatePage.getByRole('heading', { name: JOB.jobNumber })).toBeVisible();

  await delegatePage.getByRole('button', { name: 'Verify' }).click();
  await drawSignature(delegatePage);
  await delegatePage.getByRole('button', { name: 'Done' }).click();

  await expect(
    delegatePage.getByRole('heading', { name: 'Re-enter your password to sign' }),
  ).toBeVisible();
  await delegatePage.locator('#step-up-password').fill(E2E_PASSWORD);
  await delegatePage.getByRole('button', { name: 'Confirm' }).click();

  await expect(delegatePage.getByText('Verified. Awaiting the next approval stage.')).toBeVisible();

  const step = delegatePage.locator('.approval-step').first();
  await expect(step).toContainText('VERIFIED');
  await expect(step).toContainText(E2E_USERS.teamLeader.fullName);
  await delegateContext.close();
});
