import { test, expect, type Page } from '@playwright/test';
import { FakeServer, type SeedJob } from '../support/fake-server';

const JOB: SeedJob = {
  id: 'job-1',
  jobNumber: 'PM-2026-000431',
  assetCode: 'AW03',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [{ id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' }],
};

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
}

/**
 * O-13: the same job opened on two devices by the same user — conflict
 * detected on the second sync, resolution prompted.
 *
 * Two independent BrowserContexts (two "devices") share ONE FakeServer
 * instance (a Node-side object, installed as route handlers on both), so
 * the server-side draftVersion tracking added for this suite (see
 * fake-server.ts) genuinely arbitrates between them — this is not two
 * canned one-shot conflicts, it is the real optimistic-concurrency
 * mechanism the contract describes (`If-Match` against the job's
 * `draftVersion`).
 */
test('O-13: two devices editing the same job — the second device to sync gets a real conflict', async ({
  browser,
}) => {
  const server = new FakeServer();
  server.seedJob(JOB);

  const contextA = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const contextB = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const deviceA = await contextA.newPage();
  const deviceB = await contextB.newPage();
  await server.install(deviceA);
  await server.install(deviceB);

  await signIn(deviceA);
  await signIn(deviceB);

  // Both devices go offline and edit the SAME item independently, both
  // starting from the same bootstrapped draftVersion (1).
  await deviceA.getByText(JOB.jobNumber).click();
  await deviceB.getByText(JOB.jobNumber).click();
  await deviceA.context().setOffline(true);
  await deviceB.context().setOffline(true);

  const doneA = deviceA.getByRole('button', { name: 'Done', exact: true });
  const notDoneB = deviceB.getByRole('button', { name: 'Not done', exact: true });
  await doneA.click();
  await notDoneB.click();
  // Wait for the real committed state (aria-pressed), not "Held on device"
  // text — that is also the trivial default before any append lands.
  await expect(doneA).toHaveAttribute('aria-pressed', 'true');
  await expect(notDoneB).toHaveAttribute('aria-pressed', 'true');

  // Device A reconnects first — its edit is based on the correct (current)
  // version, so it applies and the job's real draftVersion advances.
  await deviceA.context().setOffline(false);
  await deviceA.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(deviceA.getByRole('button', { name: 'Submit' })).toBeEnabled({ timeout: 10_000 });

  // Device B reconnects second — its edit still carries the OLD version
  // (it queued its mutation before ever seeing A's change), so the server
  // genuinely rejects it as a conflict.
  await deviceB.context().setOffline(false);
  await deviceB.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(deviceB.getByText('Conflict — needs your input')).toBeVisible({ timeout: 10_000 });

  await contextA.close();
  await contextB.close();
});

/**
 * O-14: a job reassigned server-side while cached on the original device —
 * that device is informed on its next sync and cannot submit.
 */
test('O-14: a job reassigned server-side is flagged on the original device and blocks submit', async ({
  page,
}) => {
  const server = new FakeServer();
  server.seedJob(JOB);
  await server.install(page);
  await signIn(page);

  await page.getByText(JOB.jobNumber).click();
  await page.context().setOffline(true);
  const doneButton = page.getByRole('button', { name: 'Done', exact: true });
  await doneButton.click();
  // "Held on device" is also the default initial state, so it is visible
  // immediately regardless of whether the append has actually landed —
  // wait for the button's real `aria-pressed` state instead, which only
  // flips once `recordItemStatus`'s append has resolved.
  await expect(doneButton).toHaveAttribute('aria-pressed', 'true');

  // The job is reassigned/withdrawn on the server while this device is
  // offline with unsynced work for it.
  server.removeJob(JOB.id);

  // Reconnect BEFORE going back — the job list's re-bootstrap on mount
  // needs to actually reach the (now-updated) server to learn the job is
  // gone; going back while still offline would just fail to reach it at
  // all and tell us nothing about O-14.
  await page.context().setOffline(false);
  await page.goBack(); // back to the job list — this re-bootstraps
  await expect(page.getByText('Reassigned — cannot submit')).toBeVisible({ timeout: 10_000 });

  await page.getByText(JOB.jobNumber).click();
  await expect(page.getByText(/reassigned or removed on the server/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Submit|Sending/ })).toBeDisabled();
});
