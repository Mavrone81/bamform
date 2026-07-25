import { test, expect } from '../support/fixtures';

/**
 * O-10: a template revision is issued while a job is cached offline — the
 * cached job keeps its frozen revision. sync-engine.test.ts proves the
 * merge-protection logic directly; this proves the same protection holds
 * through the real UI: the technician keeps seeing (and can keep working
 * against) the original checklist item text even after a background
 * re-sync would otherwise have brought in a different revision.
 *
 * The edit must genuinely remain UNSYNCED (`hasPendingOutbox: true`) at the
 * moment the second bootstrap runs — the protection is explicitly scoped
 * to that (once an edit is safely on the server, there is nothing left to
 * protect). `dropNextOutboxResponseOnce` keeps the item mutation's outbox
 * row `pending` (the server "received" it, the client never found out) —
 * the same O-15 fault, used here to hold the job in the right precondition
 * — while leaving `/sync/bootstrap` itself unaffected so the re-sync this
 * scenario is actually about can proceed normally.
 */
test('O-10: a job with unsynced local edits keeps its original checklist text through a later re-sync', async ({
  signedInPage: page,
  server,
}) => {
  await page.getByText('PM-2026-000431').click();
  await expect(page.getByText('Check heater block temperature')).toBeVisible();

  server.dropNextOutboxResponseOnce();
  const doneButton = page.getByRole('button', { name: 'Done', exact: true }).first();
  const outboxRequest = page.waitForRequest('**/api/v1/sync/outbox');
  await doneButton.click();
  const req = await outboxRequest;
  const mutationId = (req.postDataJSON() as { mutations: { id: string }[] }).mutations[0].id;
  await expect.poll(() => server.appliedCount.get(mutationId)).toBe(1); // committed server-side...
  await expect(doneButton).toHaveAttribute('aria-pressed', 'true'); // ...the technician still sees their own tap (optimistic, durable in IndexedDB regardless of ack)
  await expect(page.getByText('Held on device')).toBeVisible(); // ...but the job is NOT yet "received by server"

  // A new template revision is issued for this asset type while the job
  // sits with unsynced work — the (defensive) incoming snapshot for the
  // SAME job id now carries different checklist wording.
  server.seedJob({
    id: 'job-1',
    jobNumber: 'PM-2026-000431',
    assetCode: 'AW03',
    frequency: 'M3',
    dueOn: '2026-08-01',
    revisionCode: 'B',
    items: [{ id: 'item-1', itemNo: 1, instruction: 'REVISED WORDING — should never appear' }],
  });

  await page.goBack(); // job list re-mount → re-bootstraps
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
  await page.getByText('PM-2026-000431').click();

  await expect(page.getByText('Check heater block temperature')).toBeVisible(); // frozen — unchanged
  await expect(page.getByText('REVISED WORDING')).toHaveCount(0);
  await expect(page.getByText('rev A')).toBeVisible(); // original revision code, not B
});
