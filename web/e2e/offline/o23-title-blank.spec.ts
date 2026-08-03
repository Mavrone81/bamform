import { test, expect, signAndSubmit, signInAs } from '../support/fixtures';
import { FakeServer, type SeedJob } from '../support/fake-server';

/**
 * O-23 (slice 31-TITLEBLANK): the blank in the form's TITLE survives the
 * offline path and gates submit.
 *
 * Eight of the twelve controlled templates carry one (`ED____`, `KW___`,
 * `AVS 35-____`, ...). It used to be filled once by an admin on the
 * machine-document tag; the owner ruled that wrong, and with the migration no
 * longer setting it, nothing filled it at all — a printed record would have
 * shown the blank empty forever.
 *
 * The unit suite proves the outbox row's shape and the screen's merge rule
 * against a real Dexie; this proves the same thing through the REAL browser,
 * a real service worker reload, and a fake server that refuses an unfilled
 * submission exactly as the api does.
 */

const FILLABLE_TITLE = 'BESi Die Attach Preventive Maintenance Record ED____';

const TITLED_JOB: SeedJob = {
  id: 'job-1',
  jobNumber: 'PM-2026-000431',
  assetCode: 'ED01',
  frequency: 'M3',
  dueOn: '2026-08-01',
  title: FILLABLE_TITLE,
  items: [{ id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' }],
};

async function openTitledJob(page: Parameters<typeof signInAs>[0], job: SeedJob = TITLED_JOB) {
  const server = new FakeServer();
  server.seedJob(job);
  await server.install(page);
  await signInAs(page);
  await page.getByText(job.jobNumber).click();
  await expect(page.getByRole('heading', { name: job.jobNumber })).toBeVisible();
  return server;
}

test('O-23a: the form number is captured offline, survives a reload, and reaches the server on reconnect', async ({
  page,
}) => {
  const server = await openTitledJob(page);
  const box = page.getByLabel('Form number in the title');

  // It starts EMPTY — never inferred from `ED01`, the machine code sitting
  // right there in the header. That guess is wrong on two of the eight real
  // title shapes, so it is not made.
  await expect(box).toHaveValue('');
  // The raw title is shown so they can see WHICH blank they are filling.
  await expect(page.getByText(FILLABLE_TITLE)).toBeVisible();

  await page.context().setOffline(true);
  await box.fill('01');
  await page.getByRole('button', { name: 'Done', exact: true }).first().click();

  // Nothing has reached the server yet, and the entry is durable.
  await expect(page.getByText('Held on device')).toBeVisible();
  expect(server.outboxRequestCount).toBe(0);

  // Leaving and re-opening the record while still offline must show what they
  // typed. This re-mounts the capture screen, so it re-runs the hydration
  // that reads the server snapshot — which still says NULL, because the entry
  // is queued and unsent. Before the outbox merge existed the box came back
  // EMPTY here, silently re-blocking submit for a value already safely held.
  await page.getByRole('button', { name: /Back to your jobs/i }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByLabel('Form number in the title')).toHaveValue('01', { timeout: 10_000 });

  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect(page.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
    timeout: 10_000,
  });
  await signAndSubmit(page);
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  expect(server.submitCount.get('job-1')).toBe(1);
  const paths = server.receivedBatches.flat().map((m) => m.path);
  expect(paths).toContain('/jobs/job-1/title-machine-number');
});

test('O-23b: submit is refused while the blank is empty — the button says why, and the server would refuse too', async ({
  page,
}) => {
  const server = await openTitledJob(page);

  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(page.getByText('Held on device')).toBeVisible();

  // The one control that would send the record refuses, and names the reason.
  const blocked = page.getByRole('button', { name: /Enter the form number above to submit/i });
  await expect(blocked).toBeVisible({ timeout: 10_000 });
  await expect(blocked).toBeDisabled();
  expect(server.submitCount.get('job-1')).toBeUndefined();

  // Filling it releases the block.
  await page.getByLabel('Form number in the title').fill('01');
  await expect(page.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
    timeout: 10_000,
  });
  await signAndSubmit(page);
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  expect(server.submitCount.get('job-1')).toBe(1);
});

test('O-23c: a form whose title has no blank is never asked for one', async ({ page }) => {
  const server = await openTitledJob(page, {
    ...TITLED_JOB,
    title: 'Epoxy Dispenser EP01 Preventive Maintenance Record',
  });

  await expect(page.getByLabel('Form number in the title')).toHaveCount(0);

  await page.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Sign and submit' })).toBeEnabled({
    timeout: 10_000,
  });
  await signAndSubmit(page);
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  expect(server.submitCount.get('job-1')).toBe(1);
});
