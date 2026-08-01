import { test, expect, signAndSubmit } from '../support/fixtures';
import { FakeServer, type SeedJob } from '../support/fake-server';

/**
 * O-01: Complete a full record entirely offline, then reconnect — record
 * arrives complete, exactly once.
 *
 * The seed job here has 2 checklist items rather than the real 14-item ASM
 * Wire Bond form (U-CAS-08) — the mechanism under test (outbox → drain →
 * submit) is identical regardless of item count; using 2 keeps the test
 * fast. Item-count-specific behaviour (the cascade itself) is U-CAS-08's
 * job, not this suite's.
 */
test('O-01: full record completed offline arrives complete and exactly once on reconnect', async ({
  signedInPage: page,
  server,
}) => {
  await page.context().setOffline(true);

  await page.getByText('PM-2026-000431').click();
  await expect(page.getByRole('heading', { name: 'PM-2026-000431' })).toBeVisible();

  const items = page.locator('.checklist-item');
  await expect(items).toHaveCount(2);
  for (const item of await items.all()) {
    await item.getByRole('button', { name: 'Done', exact: true }).click();
  }

  // Still offline: nothing has reached the fake server yet.
  expect(server.outboxRequestCount).toBe(0);
  await expect(page.getByText('Held on device')).toBeVisible();

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // ensure the app's online listener fires deterministically

  await expect(page.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
    timeout: 10_000,
  });
  await signAndSubmit(page);

  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  expect(server.submitCount.get('job-1')).toBe(1);
  // Exactly 2 item mutations, each applied exactly once — no loss, no dup.
  const uniqueIds = new Set(server.receivedBatches.flat().map((m) => m.id));
  expect(uniqueIds.size).toBe(2);
  for (const id of uniqueIds) {
    expect(server.appliedCount.get(id)).toBe(1);
  }
});

/**
 * O-04: airplane mode for an extended period, multiple jobs completed —
 * all arrive on reconnect. The 8-hour duration in the scenario description
 * is about elapsed wall-clock time with no signal, which has no bearing on
 * outbox behaviour (there is no timeout on a queued mutation); what matters
 * is "N jobs, all completed while offline, all arrive" — tested here with
 * 3 jobs.
 */
test('O-04: three jobs completed during an extended offline period all arrive on reconnect', async ({
  page,
}) => {
  const server = new FakeServer();
  const jobs: SeedJob[] = [1, 2, 3].map((n) => ({
    id: `job-${n}`,
    jobNumber: `PM-2026-00043${n}`,
    assetCode: `AW0${n}`,
    frequency: 'M3',
    dueOn: '2026-08-01',
    items: [{ id: `item-${n}-1`, itemNo: 1, instruction: 'Check heater block temperature' }],
  }));
  for (const j of jobs) server.seedJob(j);
  await server.install(page);

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  await page.context().setOffline(true);

  for (const j of jobs) {
    await page.getByText(j.jobNumber).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText('Held on device')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  }

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  // All 3 jobs' single mutation each should drain to 0 pending.
  for (const j of jobs) {
    await expect(async () => {
      await page.getByText(j.jobNumber).click();
      await expect(page.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
        timeout: 10_000,
      });
      await page.goBack();
    }).toPass({ timeout: 15_000 });
  }

  const uniqueIds = new Set(server.receivedBatches.flat().map((m) => m.id));
  expect(uniqueIds.size).toBe(3);
  for (const id of uniqueIds) expect(server.appliedCount.get(id)).toBe(1);
});
