import { test, expect } from '../support/fixtures';
import { E2E_USERS, type SeedJob } from '../support/fake-server';

/**
 * D-2a (slice 16): a technician whose record was RETURNED must see what the
 * verifier flagged, and which items changed since. Honest scope: the API
 * has no field-level before/after diff — what the data supports is (a) the
 * verbatim return reason with who/when, and (b) marking items whose result
 * changed after the return (server `recordedAt` later than the return, or a
 * local not-yet-acknowledged edit). That is what is delivered and tested.
 */

const RETURNED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const RECORDED_BEFORE_RETURN = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const RETURNED_JOB: SeedJob = {
  id: 'job-ret',
  jobNumber: 'PM-2026-00077',
  assetCode: 'AW07',
  frequency: 'M1',
  dueOn: '2026-08-01',
  status: 'IN_PROGRESS',
  items: [
    { id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' },
    { id: 'item-2', itemNo: 2, instruction: 'Inspect wire bond capillary' },
  ],
  itemResults: [{ templateItemId: 'item-1', status: 'DONE' }],
  submittedAt: RECORDED_BEFORE_RETURN,
  approvalSteps: [
    {
      stageOrdinal: 0,
      stageLabel: 'Submitted',
      action: 'SUBMITTED',
      actorId: E2E_USERS.technician.id,
      actorName: E2E_USERS.technician.fullName,
      actedAt: RECORDED_BEFORE_RETURN,
    },
    {
      stageOrdinal: 1,
      stageLabel: 'Returned',
      action: 'RETURNED',
      actorId: E2E_USERS.teamLeader.id,
      actorName: E2E_USERS.teamLeader.fullName,
      reason: 'Item 2 was not inspected — the capillary check box is empty.',
      actedAt: RETURNED_AT,
    },
  ],
};

test('E-08: a returned record shows the verifier’s reason prominently, and marks items edited after the return', async ({
  page,
  server,
  signedInPage,
}) => {
  void signedInPage;
  server.seedJob(RETURNED_JOB);
  // The fixture signed in before this job was seeded — resync.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();

  await page.getByText(RETURNED_JOB.jobNumber).click();
  await expect(page.getByRole('heading', { name: RETURNED_JOB.jobNumber })).toBeVisible();

  // (a) The return is prominent and verbatim: who, when, why.
  const banner = page.getByRole('alert').filter({ hasText: 'Returned by' });
  await expect(banner).toContainText(`Returned by ${E2E_USERS.teamLeader.fullName}`);
  await expect(banner).toContainText(
    'Item 2 was not inspected — the capillary check box is empty.',
  );

  // (b) Nothing has been edited since the return yet — no marks on any
  // checklist item (the banner's explanatory copy also carries the phrase,
  // so scope to the items).
  const items = page.locator('.checklist-item');
  await expect(items.getByText('Edited since return')).toBeHidden();

  // The technician fixes the flagged item — the mark appears on THAT item.
  await items.nth(1).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(items.nth(1).getByText('Edited since return')).toBeVisible();
  await expect(items.nth(0).getByText('Edited since return')).toBeHidden();
});
