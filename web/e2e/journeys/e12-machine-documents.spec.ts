import { test, expect, signInAs } from '../support/fixtures';
import { E2E_USERS } from '../support/fake-server';

/**
 * Slice 28-ASSETDOC-UI — the two of the owner's nine process steps that had no
 * screen at all until now.
 *
 * > 2. Admin will log in to setup the machine tagged with which preventive
 * >    Maintenance document — all the forms in the doc folder.
 * > 4. Once confirmed that he / she has been planned for, he will go to his
 * >    assigned machine and select the form to start.
 *
 * Runs at 375 / 768 / 1280 like every other journey (`VIEWPORT_WIDTH`).
 */

test.describe('E-16: an admin tags documents to a machine', () => {
  test('an untagged machine says it is inert, and stops saying so only once a document is tagged', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({ code: 'AW01', assetTypeId: 'at-1' });
    await signInAs(page, E2E_USERS.admin.email);
    await page.goto(`/admin/machines/${machine.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AW01');

    // The state slice 27's review flagged and nothing on screen ever said:
    // this machine will never do anything at all.
    const inert = page
      .getByRole('alert')
      .filter({ hasText: /carries no active preventive-maintenance document/ });
    await expect(inert).toBeVisible();
    await expect(inert).toContainText('Nothing is scheduled against it');
    await expect(inert).toContainText('ad-hoc job will be refused');

    // Tag the KNS wire-bond record — a title with a real blank (KW___).
    await page.getByLabel('Document', { exact: true }).selectOption('tpl-wb');
    await page.getByRole('button', { name: 'Tag this document' }).click();

    await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW___')).toBeVisible();
    await expect(inert).toHaveCount(0);
    // The blank is not yet filled, and the screen says so rather than looking
    // finished.
    await expect(page.getByText('Form number not set')).toBeVisible();

    // Fill the blank. The title the server resolves is what renders — the
    // client never substitutes anything itself.
    await page.getByLabel('Form number for CE 95 020 00 03').fill('13');
    await page.getByRole('button', { name: 'Save form number' }).click();
    await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW13')).toBeVisible();
    await expect(page.getByText('Form number not set')).toHaveCount(0);

    // It survives a reload — the change really reached the server.
    await page.reload();
    await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW13')).toBeVisible();
  });

  test('a title with the number already printed is offered NO form-number box at all', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({ code: 'EP01', assetTypeId: 'at-1' });
    await signInAs(page, E2E_USERS.admin.email);
    await page.goto(`/admin/machines/${machine.id}`);

    // EP01's title carries the number already — there is nothing to fill, so
    // the admin is never shown a box that would do nothing.
    await page.getByLabel('Document', { exact: true }).selectOption('tpl-ep');
    await page.getByRole('button', { name: 'Tag this document' }).click();
    await expect(
      page.getByText('Epoxy Dispenser EP01 Preventive Maintenance Record'),
    ).toBeVisible();
    await expect(page.getByLabel('Form number for CE 95 020 00 01')).toHaveCount(0);
    // ABSENT, not merely disabled.
    await expect(page.locator('input[id^="doc-number-"]')).toHaveCount(0);

    // And the same document cannot be tagged twice — it is not offered again,
    // so the 409 is a dead end the admin never reaches.
    await expect(page.getByLabel('Document', { exact: true })).not.toContainText('CE 95 020 00 01');
  });

  test('retiring the last document puts the machine straight back into its inert state', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({ code: 'AW02', assetTypeId: 'at-1' });
    server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: 'tpl-wb',
      machineNumber: '7',
    });
    await signInAs(page, E2E_USERS.admin.email);
    await page.goto(`/admin/machines/${machine.id}`);
    await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW7')).toBeVisible();

    const inert = page
      .getByRole('alert')
      .filter({ hasText: /carries no active preventive-maintenance document/ });
    await expect(inert).toHaveCount(0);

    await page.getByRole('button', { name: 'Retire' }).click();

    // There is no DELETE anywhere in this system: the row stays, marked, and
    // the machine is honestly reported as inert again.
    await expect(page.getByText('Retired', { exact: true })).toBeVisible();
    await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW7')).toBeVisible();
    await expect(inert).toBeVisible();

    // Reversible — it was retired, not destroyed.
    await page.getByRole('button', { name: 'Return to service' }).click();
    await expect(inert).toHaveCount(0);
  });

  test('a machine outside the caller’s area scope is refused by the server, documents and all', async ({
    page,
    server,
    browser,
  }) => {
    const bondLine = server.seedArea({ code: 'BL', name: 'Bond Line' });
    const testBay = server.seedArea({ code: 'TB', name: 'Test Bay' });
    const machine = server.seedAsset({ code: 'AW03', assetTypeId: 'at-1' });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: 'tpl-wb' });

    // The machine sits in Bond Line; the engineer can only reach Test Bay.
    await signInAs(page, E2E_USERS.admin.email);
    await page.goto(`/admin/machines/${machine.id}`);
    await page.getByLabel('Area', { exact: true }).selectOption({ label: 'Bond Line (BL)' });
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.locator('.banner[data-tone="good"]')).toContainText('Saved.');
    void bondLine;
    server.seedUserAreaScope(E2E_USERS.engineer.id, [testBay.id]);

    // A second actor needs their own context — one browser profile holds one
    // session (the pattern E-06 established).
    const context = await browser.newContext();
    const scoped = await context.newPage();
    await server.install(scoped);
    await signInAs(scoped, E2E_USERS.engineer.email);
    await scoped.goto(`/admin/machines/${machine.id}`);

    // Non-negotiable #6: the URL stays reachable and the SERVER refuses. No
    // document list, no tagging control, no leaked title.
    await expect(scoped.getByRole('alert')).toBeVisible();
    await expect(scoped.getByLabel('Document', { exact: true })).toHaveCount(0);
    await expect(scoped.getByText('KNS Wire Bond Preventive Maintenance Record')).toHaveCount(0);
    await context.close();
  });
});

test.describe('E-17: a maintainer selects the form to start', () => {
  test('a machine carrying several documents makes the choice explicit — and the raise carries it', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({ code: 'AW04', assetTypeId: 'at-1' });
    const wireBond = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: 'tpl-wb',
      machineNumber: '13',
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: 'tpl-ep' });
    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/jobs/raise');

    await page.getByLabel('Machine', { exact: true }).selectOption(machine.id);
    const picker = page.getByLabel('Which document');
    await expect(picker).toBeVisible();

    const raise = page.getByRole('button', { name: 'Raise this job' });
    await page
      .getByLabel('Why is this being raised off-plan?')
      .fill('bearing seized on the night shift, unplanned service');
    // The server's 422 ("name the one this work is recorded on") is
    // unreachable: nothing can be raised until a document is named.
    await expect(raise).toBeDisabled();

    await picker.selectOption(wireBond.id);
    await expect(raise).toBeEnabled();
    await raise.click();
    await expect(page.getByRole('heading', { name: /^PM-2026-9/ })).toBeVisible();
  });

  test('a machine carrying exactly one document does not force a choice', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({ code: 'AW05', assetTypeId: 'at-1' });
    server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: 'tpl-wb',
      machineNumber: '21',
    });
    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/jobs/raise');
    await page.getByLabel('Machine', { exact: true }).selectOption(machine.id);

    await expect(page.getByLabel('Which document')).toHaveCount(0);
    // Named, not hidden — the maintainer still sees which form they are about
    // to start.
    await expect(page.getByText('KNS Wire Bond Preventive Maintenance Record KW21')).toBeVisible();
    await page
      .getByLabel('Why is this being raised off-plan?')
      .fill('unplanned service after a call-out');
    await page.getByRole('button', { name: 'Raise this job' }).click();
    await expect(page.getByRole('heading', { name: /^PM-2026-9/ })).toBeVisible();
  });

  test('a machine carrying NO document says so up front instead of failing at the end', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({ code: 'AW06', assetTypeId: 'at-1' });
    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/jobs/raise');
    await page.getByLabel('Machine', { exact: true }).selectOption(machine.id);

    await expect(
      page.getByRole('alert').filter({ hasText: /carries no active preventive-maintenance/ }),
    ).toBeVisible();
    await page
      .getByLabel('Why is this being raised off-plan?')
      .fill('trying to raise work on a machine with no form');
    // Before this slice the planner filled the whole form and got a bare 422.
    await expect(page.getByRole('button', { name: 'Raise this job' })).toBeDisabled();
  });
});
