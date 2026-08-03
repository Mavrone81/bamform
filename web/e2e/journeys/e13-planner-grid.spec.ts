import { test, expect, signInAs } from '../support/fixtures';
import { E2E_TEMPLATES, E2E_USERS } from '../support/fake-server';

/**
 * E-17 (slice 31-PLANNER) — the planner lays out a year, and moves a visit.
 *
 * This is the journey `ML-S-MFT-00015` exists for and that the system could
 * not perform at all until now: look at the whole plant across the year, see
 * that one week is carrying far more than its neighbours, and move something
 * out of it. `GET /assets/{assetId}/schedule` could only ever answer for one
 * machine, so before this the answer to "what is due in week 12" was the
 * spreadsheet.
 *
 * THE CLOCK IS PINNED (`page.clock.setFixedTime`). "Past due" is
 * `nextDueOn < today` and the grid defaults to the current year, so without
 * this the overdue assertions would pass for most of the year and fail in
 * January. `setFixedTime` rather than `install`: it fixes what `Date.now()`
 * reports without freezing timers, so the app's own refresh and drain
 * scheduling behave normally.
 */

const NOW = new Date('2026-08-03T12:00:00.000Z');
const YEAR = 2026;

test.describe('E-17: a planner reads the year and moves a visit', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW);
  });

  test('the whole plant’s year is one grid, reachable from the Menu', async ({ page, server }) => {
    // Two machines on the wire-bond record (monthly) anchored in week 12, and
    // one on the epoxy record (quarterly) anchored in week 30 — enough that
    // the load row has a shape rather than a flat line.
    for (const code of ['AW01', 'AW02']) {
      const machine = server.seedAsset({
        code,
        assetTypeId: 'at-1',
        scheduleAnchorDate: `${YEAR}-03-19`,
      });
      server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });
    }
    const quarterly = server.seedAsset({
      code: 'EP07',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-07-27`,
    });
    server.seedAssetDocument({ assetId: quarterly.id, formTemplateId: E2E_TEMPLATES.epoxy });

    // A team leader is one of the four roles that may adjust a schedule, so
    // the Menu offers the plan. Reached the way a planner reaches it.
    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.getByRole('button', { name: 'Menu' }).click();
    const entry = page.getByRole('button', { name: 'Maintenance plan' });
    await entry.scrollIntoViewIfNeeded();
    await entry.click();

    await expect(page.getByRole('heading', { name: `Maintenance plan ${YEAR}` })).toBeVisible();
    const grid = page.getByRole('table');
    await expect(grid).toBeVisible();

    // Machines down the side — the spreadsheet's own layout.
    await expect(page.getByRole('rowheader', { name: /AW01/ })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: /AW02/ })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: /EP07/ })).toBeVisible();

    // 52 work weeks across, each column carrying BOTH units: the week number
    // the planner thinks in and the date the system stores.
    const weekHeaders = page.getByRole('columnheader');
    await expect(weekHeaders).toHaveCount(53); // 52 weeks + the machine column
    await expect(weekHeaders.nth(1)).toContainText('WW01');
    await expect(weekHeaders.nth(1)).toContainText('1 Jan');
    await expect(weekHeaders.nth(52)).toContainText('WW52');

    // 19 March is work week 12 counting sevens from 1 January.
    await expect(page.getByRole('button', { name: /AW01.*WW12/ })).toBeVisible();
  });

  test('the page never scrolls sideways — the grid scrolls inside its own region', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-03-19`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    // The tablet width this is used at, where 52 columns cannot possibly fit.
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    const region = page.getByRole('region', { name: /Machines down the side/ });
    await expect(region).toBeVisible();

    // The grid genuinely overflows...
    const overflows = await region.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflows).toBe(true);

    // ...and the BODY does not. A page that scrolls sideways loses its own
    // heading and the navigation rail off the left edge.
    const bodyOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(bodyOverflows).toBe(false);

    // The region can be scrolled without a pointer (WCAG 2.1.1).
    await expect(region).toHaveAttribute('tabindex', '0');
  });

  test('a past-due visit is obvious by icon and word, never by colour alone (A-05)', async ({
    page,
    server,
  }) => {
    const late = server.seedAsset({
      code: 'AW09',
      assetTypeId: 'at-1',
      // Well before the pinned "today" of 3 August.
      scheduleAnchorDate: `${YEAR}-02-04`,
    });
    server.seedAssetDocument({ assetId: late.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');

    // 4 February is day 35 of the year, so work week 5 counting sevens
    // from 1 January.
    const cell = page.getByRole('button', { name: /AW09.*WW05/ });
    await expect(cell).toBeVisible();
    // Words, not a red square: the cell says LATE and its accessible name
    // says "past due".
    await expect(cell).toContainText('LATE');
    await expect(cell).toHaveAccessibleName(/past due/);
    const icon = await cell.locator('[aria-hidden="true"]').first().textContent();
    expect(icon?.trim().length).toBeGreaterThan(0);

    // And the count is announced, with what it means for the rest of the line.
    const banner = page.getByTestId('planner-overdue-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/past due/);
  });

  test('load per week is readable as a number, and a heavy week is flagged in words', async ({
    page,
    server,
  }) => {
    // Four machines on the quarterly record, all anchored 19 March, so weeks
    // 12/25/38/51 each carry four visits...
    for (const code of ['AW01', 'AW02', 'AW03', 'AW04']) {
      const machine = server.seedAsset({
        code,
        assetTypeId: 'at-1',
        scheduleAnchorDate: `${YEAR}-03-19`,
      });
      server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.epoxy });
    }
    // ...against one machine on the monthly record from 5 August, spreading
    // single visits over weeks 31/36/40/45/49. That contrast is the whole
    // point: "heavy" is relative to the plan's own normal week (half again
    // the average LOADED week), not a tunable number nobody would tune.
    const light = server.seedAsset({
      code: 'EP07',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-08-05`,
    });
    server.seedAssetDocument({ assetId: light.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    // The value is TEXT — a bar alone would be invisible to a screen reader
    // and unreadable at a glance without a scale.
    const loadRow = page.getByRole('row', { name: /^Load/ });
    await expect(loadRow).toBeVisible();
    await expect(page.getByText(/WW12.*4 items due, a heavy week/)).toBeVisible();
  });

  /**
   * THE POINT OF THE SCREEN. Two visits sit in week 12; the planner moves one
   * of them out. The write goes through the SAME
   * `PUT /assets/{assetId}/schedule` the per-machine editor uses, with the
   * same mandatory ten-character reason — this asserts the reason floor is
   * really enforced here, because that is the guarantee the audit trail rests
   * on and the one a second, copied editor would quietly lose.
   */
  test('a planner opens a cell and moves the visit, giving a reason', async ({ page, server }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
      machineNumber: '13',
    });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');

    // 17 September is work week 38.
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();

    const detail = page.getByTestId('planner-detail');
    await expect(detail).toBeVisible();
    // The blank in the title is resolved, exactly as everywhere else.
    await expect(detail).toContainText('KNS Wire Bond Preventive Maintenance Record KW13');
    // Both units, together.
    await expect(detail).toContainText('WW38');
    await expect(detail).toContainText('17 Sep');

    await page.getByRole('button', { name: /Move next due date for/ }).click();
    const save = page.getByRole('button', { name: 'Save' });

    // The server's own floor, enforced before the request is ever made — a
    // shorter reason would 422 with a detail that names no field.
    await expect(save).toBeDisabled();
    await page.getByLabel('Reason for this change').fill('too short');
    await expect(save).toBeDisabled();

    await page.getByLabel('Next due date').fill(`${YEAR}-10-15`);
    await page.getByLabel('Reason for this change').fill('Levelling load out of week 38');
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByText(/Next due date saved for/)).toBeVisible();
    // The plan is redrawn: the visit has left week 38 for week 42 (15 Oct).
    await expect(page.getByRole('button', { name: /AW01.*WW42/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /AW01.*WW38/ })).toHaveCount(0);
  });

  /**
   * The honest limit of the grid: only `next_due_on` is stored. Offering an
   * editor on a later, projected cell would move the whole rule there and
   * silently skip every visit in between.
   */
  test('a projected visit says why it cannot be moved on its own', async ({ page, server }) => {
    const machine = server.seedAsset({
      code: 'EP07',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.epoxy });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');

    // Quarterly from 17 September: the next one is 17 December, work week 51.
    await page.getByRole('button', { name: /EP07.*WW51/ }).click();
    const detail = page.getByTestId('planner-detail');
    await expect(detail).toContainText('Projected, not stored');
    await expect(detail.getByRole('button', { name: /Move next due date/ })).toHaveCount(0);
  });

  test('a maintainer can read the plan but is offered nothing to move', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-03-19`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    // The Menu does not offer the entry to a maintainer, but the URL stays
    // reachable — non-negotiable #6: the server decides, and `GET /schedule`
    // carries no role gate at all.
    await signInAs(page, E2E_USERS.technician.email);
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('button', { name: 'Maintenance plan' })).toHaveCount(0);

    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText(/Moving a visit needs a planner/)).toBeVisible();

    await page.getByRole('button', { name: /AW01.*WW12/ }).click();
    await expect(page.getByTestId('planner-detail')).toBeVisible();
    await expect(page.getByRole('button', { name: /Move next due date/ })).toHaveCount(0);
  });

  test('a year with nothing scheduled says so, rather than showing a bare grid', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-03-19`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    // A year before anything is anchored has no visits at all.
    await page.getByRole('button', { name: `Show ${YEAR - 1}` }).click();
    await expect(page.getByRole('heading', { name: `Maintenance plan ${YEAR - 1}` })).toBeVisible();
    await expect(page.getByText(/Nothing is scheduled in/)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
