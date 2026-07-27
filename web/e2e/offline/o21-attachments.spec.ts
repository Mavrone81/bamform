import { test, expect, DEFAULT_JOB } from '../support/fixtures';

/**
 * D-2b (O-21): attachment capture is ONLINE-ONLY in v1 — photos upload
 * straight to the server and are never queued into the offline outbox
 * (quota consequences of binary blobs, PR-069). These journeys prove the
 * whole surface: capture → preview → remove-before-submit → upload with
 * progress → failure + retry → the offline refusal, and that the outbox is
 * never involved. O-06/O-07 ("attachments pending" at submit/verify) are
 * unreachable states under this design — see docs/TEST_PLAN.md.
 */

const PHOTO = {
  name: 'evidence.jpg',
  mimeType: 'image/jpeg',
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]),
};

test('O-21a: capture → preview → upload → received; the outbox never carries the photo; Submit stays available', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();

  await page.getByLabel('Add a photo (camera or gallery)').setInputFiles(PHOTO);
  const staged = page.getByTestId('staged-photo');
  await expect(staged.getByAltText('Preview of evidence.jpg')).toBeVisible();
  await expect(staged.getByText('Not uploaded yet')).toBeVisible();

  // A staged photo blocks Submit — submitting would silently discard it.
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await expect(page.getByText(/Upload or remove the photos above/)).toBeVisible();

  await staged.getByRole('button', { name: 'Upload photo' }).click();
  await expect(staged.getByText('Received by server')).toBeVisible({ timeout: 10_000 });
  expect(server.attachments.get(DEFAULT_JOB.id)).toHaveLength(1);

  // The photo travelled OUTSIDE the outbox: no /sync/outbox request carried it.
  expect(server.receivedBatches.flat().filter((m) => m.path.includes('attachment'))).toHaveLength(
    0,
  );
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
});

test('O-21b: remove-before-submit really removes — nothing reaches the server', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await page.getByLabel('Add a photo (camera or gallery)').setInputFiles(PHOTO);
  const staged = page.getByTestId('staged-photo');
  await expect(staged).toBeVisible();

  await staged.getByRole('button', { name: 'Remove' }).click();
  await expect(staged).toBeHidden();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  expect(server.attachments.get(DEFAULT_JOB.id) ?? []).toHaveLength(0);
});

test('O-21c: a server rejection is shown honestly, and retry succeeds', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await page.getByLabel('Add a photo (camera or gallery)').setInputFiles(PHOTO);
  const staged = page.getByTestId('staged-photo');

  server.forceNextUploadRejectionOnce(422, 'Not a supported image');
  await staged.getByRole('button', { name: 'Upload photo' }).click();
  await expect(staged.getByText('Not a supported image')).toBeVisible({ timeout: 10_000 });
  expect(server.attachments.get(DEFAULT_JOB.id) ?? []).toHaveLength(0);

  await staged.getByRole('button', { name: 'Retry upload' }).click();
  await expect(staged.getByText('Received by server')).toBeVisible({ timeout: 10_000 });
  expect(server.attachments.get(DEFAULT_JOB.id)).toHaveLength(1);
});

test('O-21d: offline, photo capture is refused with a clear message — and NOTHING is queued for later', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText(DEFAULT_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: DEFAULT_JOB.jobNumber })).toBeVisible();

  await page.context().setOffline(true);
  await expect(page.getByText(/Photos need a connection/)).toBeVisible();
  await expect(page.getByLabel('Add a photo (camera or gallery)')).toBeHidden();

  // Checklist capture is UNAFFECTED — that is the whole point of the split.
  const items = page.locator('.checklist-item');
  await items.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(items.nth(0).getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Reconnect: the queued CHECKLIST entry drains; no attachment ever does.
  await page.context().setOffline(false);
  await expect.poll(() => server.receivedBatches.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(server.attachments.get(DEFAULT_JOB.id) ?? []).toHaveLength(0);
  expect(server.receivedBatches.flat().filter((m) => m.path.includes('attachment'))).toHaveLength(
    0,
  );
});
