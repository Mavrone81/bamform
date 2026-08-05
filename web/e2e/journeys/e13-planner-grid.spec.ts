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

  /**
   * Review I-1. This test used to step BACK a year to reach the empty state,
   * which pinned the defect as correct: `schedule_rule` holds one current
   * next-due date and the server projects it forward only, so a past year is
   * near-empty by construction — and the screen then told a planner nothing
   * had been scheduled in a year the plant certainly worked. The fixture was
   * anchored in 2026, so the empty result happened to be truthful and CI
   * would never have noticed.
   *
   * The stepper is floored now, and the empty state is reached the only way
   * it can be reached truthfully: a filter that genuinely matches nothing.
   */
  test('the year cannot be stepped into the past, and says why', async ({ page, server }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-03-19`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    await expect(page.getByRole('button', { name: `Show ${YEAR - 1}` })).toBeDisabled();
    const floor = page.getByTestId('planner-year-floor');
    await expect(floor).toContainText('forward plan');
    // It points at where the past really is, instead of implying there is none.
    await expect(floor).toContainText('record archive');

    // Forward still works, and coming back re-locks at the current year.
    await page.getByRole('button', { name: `Show ${YEAR + 1}` }).click();
    await expect(page.getByRole('heading', { name: `Maintenance plan ${YEAR + 1}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Show ${YEAR}` })).toBeEnabled();
    await page.getByRole('button', { name: `Show ${YEAR}` }).click();
    await expect(page.getByRole('button', { name: `Show ${YEAR - 1}` })).toBeDisabled();
  });

  test('an empty plan states what it cannot show, and never blames a cause it cannot know', async ({
    page,
    server,
  }) => {
    // A wire bonder that IS scheduled, so the grid is not empty overall...
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-03-19`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    // ...and a machine type with nothing on it at all: a truthful empty.
    await page.getByLabel('Machine type').selectOption({ label: 'Aging Oven' });

    const empty = page.getByTestId('planner-empty');
    await expect(empty).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(empty).toContainText(`No maintenance is planned in ${YEAR} for this machine type`);
    await expect(empty).toContainText('cannot show visits already carried out');
    // Causes are offered as things to CHECK — none is asserted.
    await expect(empty).toContainText('If you expected something here, check');
    await expect(empty).not.toContainText('A machine schedules work once it carries');
  });

  /**
   * E-18 (slice 32-PLANNERJOB) — THE PLAN REACHES THE WORK.
   *
   * Until this, the planner could see a visit was due and had no way to open
   * it: the job list is ordered by machine and date and a planner had to hunt
   * for the right record by eye. This walks the join end to end — select the
   * due cell, open the job the server named, land on the capture screen.
   */
  test('a planner opens the job the scheduler already raised for a due visit', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
      machineNumber: '13',
    });
    // A sweep has already raised the job for the STORED next-due date. Keyed
    // `(document, frequency, dueOn)` — the same key the real repository
    // matches, so a looser match in the app would fail here rather than pass.
    const job = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M1',
      dueOn: `${YEAR}-09-17`,
      assetCode: 'AW01',
      status: 'SCHEDULED',
    });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');

    // 17 September is work week 38.
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    const detail = page.getByTestId('planner-detail');
    await expect(detail).toBeVisible();

    // The job is NAMED and its state said in words — never a bare coloured
    // dot (A-05).
    await expect(detail).toContainText(job.jobNumber);
    await expect(detail).toContainText('SCHEDULED');

    await detail.getByRole('button', { name: new RegExp(`Open job ${job.jobNumber}`) }).click();

    // ...and it really opens. The destination is a live capture screen, not a
    // link into a 404 — which is the half a unit test cannot prove.
    await expect(page.getByRole('heading', { name: job.jobNumber })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}$`));
  });

  /**
   * THE DEEP LINK ON A DEVICE THAT HAS NEVER SYNCED THIS JOB — the defect
   * behind CI's red E-18, made deterministic.
   *
   * The capture screen reads from the offline cache, and the JOB LIST is the
   * only screen that fills it. `/planner` never bootstraps, so a planner who
   * arrives there directly — a bookmark, a reload, a shared link — has an
   * empty cache and every "Open job" used to dead-end on "not cached on this
   * device… sync from the job list first", advice that is both wrong and
   * unactionable when the job list is not where they were going.
   *
   * The cache is emptied EXPLICITLY here rather than relying on losing a race
   * (which is what made the sibling test below flaky locally and consistently
   * red on CI). Nothing repopulates it between the clear and the click, so
   * this heading can only appear if the screen fetches the job itself.
   */
  test('opens a job on a device whose cache has never seen it', async ({ page, server }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
    });
    const job = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M1',
      dueOn: `${YEAR}-09-17`,
      assetCode: 'AW01',
    });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    // Empty the device's job cache, exactly as a planner who never opened the
    // job list would have it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const req = indexedDB.open('bamform-offline');
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('jobs2')) return resolve();
            const tx = db.transaction('jobs2', 'readwrite');
            tx.objectStore('jobs2').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          };
          req.onerror = () => resolve();
        }),
    );

    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    await page
      .getByTestId('planner-detail')
      .getByRole('button', { name: new RegExp(`Open job ${job.jobNumber}`) })
      .click();

    // The screen fetches what it does not have instead of sending the planner
    // away — and lands on the RIGHT job.
    await expect(page.getByRole('heading', { name: job.jobNumber })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}$`));
    await expect(page.getByText('not cached on this device')).toHaveCount(0);
  });

  /**
   * The other half, and the one that keeps a planner out of trouble: a visit
   * with no job says WHEN it will appear, using the server's own boundary, and
   * never offers to raise it. `POST /jobs/adhoc` creates a job with an EMPTY
   * `frequencyScope`, structurally incapable of advancing
   * `schedule_rule.next_due_on` — raising planned work that way records it
   * off-plan AND leaves the schedule overdue for ever.
   */
  test('a visit with no job says when one will appear, and offers no way to raise it', async ({
    page,
    server,
  }) => {
    // A machine family with a 45-day lead time, deliberately not the default
    // 30: the screen must print the SERVER's boundary, not one of its own.
    const family = server.seedAssetType({ code: 'LT', name: 'Long Lead Bonder', leadTimeDays: 45 });
    const machine = server.seedAsset({
      code: 'AW05',
      assetTypeId: family.id,
      scheduleAnchorDate: `${YEAR}-12-19`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');

    // 19 December is work week 51.
    await page.getByRole('button', { name: /AW05.*WW51/ }).click();
    const detail = page.getByTestId('planner-detail');

    const pending = detail.getByTestId('visit-job-pending');
    await expect(pending).toBeVisible();
    // 19 December less 45 days. A screen doing this arithmetic itself would
    // have said 19 November.
    await expect(pending).toContainText(`4 Nov ${YEAR}`);
    await expect(pending).toContainText('nothing to open until then');

    // Nothing to open, and nothing to raise — the trap this slice avoids.
    await expect(detail.getByRole('button', { name: /Open job/ })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: /Raise/i })).toHaveCount(0);
    await expect(pending).toContainText('off-plan call-out');
  });

  /**
   * The consistency the grid already keeps about its adjust form, applied to
   * the job: only `next_due_on` is stored, so only that visit can have a job.
   * The rule below HAS one — for its stored date — and the later cell on the
   * same line must not borrow it.
   */
  test('a projected visit does not borrow the stored visit’s job', async ({ page, server }) => {
    const machine = server.seedAsset({
      code: 'EP07',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.epoxy,
    });
    const job = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M3',
      dueOn: `${YEAR}-09-17`,
      assetCode: 'EP07',
    });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');

    // The stored visit (WW38) carries the job...
    await page.getByRole('button', { name: /EP07.*WW38/ }).click();
    await expect(
      page.getByTestId('planner-detail').getByRole('button', { name: /Open job/ }),
    ).toBeVisible();

    // ...and the quarterly projection three months on (17 December, WW51)
    // does not, and says so rather than going quiet.
    await page.getByRole('button', { name: /EP07.*WW51/ }).click();
    const detail = page.getByTestId('planner-detail');
    await expect(detail.getByRole('button', { name: /Open job/ })).toHaveCount(0);
    await expect(detail.getByTestId('visit-job-projected')).toContainText('none possible yet');
    await expect(detail).not.toContainText(job.jobNumber);
  });

  /**
   * Review I-2. A rule whose stored date fell in an earlier year still
   * projects visits into this one, so its row looks ordinary — it must not be
   * the only silent line on the plan, and the alert must be reachable.
   */
  test('a visit past due from before this year is named, not silently drawn as ordinary', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW09',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR - 1}-11-01`,
    });
    server.seedAssetDocument({ assetId: machine.id, formTemplateId: E2E_TEMPLATES.wireBond });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await expect(page.getByRole('table')).toBeVisible();

    // No cell of this year IS the stored date, so nothing claims to be LATE.
    // `exact` and row-scoped deliberately: Playwright's default text match is
    // a case-insensitive SUBSTRING, and "later" in the banner copy below
    // satisfies a bare `getByText('LATE')`.
    await expect(page.getByTestId('planner-overdue-banner')).toHaveCount(0);
    await expect(
      page.getByRole('row', { name: /AW09/ }).getByText('LATE', { exact: true }),
    ).toHaveCount(0);

    // ...but the machine, the date and the way to act on it are all named.
    const banner = page.getByTestId('planner-overdue-elsewhere');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(`before ${YEAR}`);
    await expect(banner).toContainText('AW09 CE 95 020 00 03');
    await expect(banner).toContainText(`1 Nov ${YEAR - 1}`);

    await banner.getByRole('button', { name: 'Machine schedules' }).click();
    await expect(page.getByRole('heading', { name: 'Machine schedules' })).toBeVisible();
  });

  /**
   * E-19 (slice 32-PLANNERJOB) — WHO DOES THE WORK, at both levels.
   *
   * The owner's ask ("allow the assigning or change assigning later") is
   * really two things, and this walks both from one panel: set who NORMALLY
   * does a machine's PM, then cover a single occurrence for somebody who is
   * away — and prove that neither wrote the other's column.
   */
  test('a planner sets who normally does the PM, then covers one visit without changing the plan', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
    });
    const job = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M1',
      dueOn: `${YEAR}-09-17`,
      assetCode: 'AW01',
    });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();

    const detail = page.getByTestId('planner-detail');
    // Two named levels, so a planner can see which one they are about to touch.
    await expect(detail.getByRole('heading', { name: 'Who normally does this' })).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Who is doing this one' })).toBeVisible();

    // ---- level 1: THE PLAN. Nobody today — the state all 220 rules are in.
    await expect(detail.getByTestId('default-assignee-none')).toContainText(
      'invisible to the technician who should do it',
    );
    await detail.getByRole('button', { name: /Set who normally does/ }).click();

    const planForm = page.getByRole('form', { name: /Set who normally does/ });
    await expect(planForm).toContainText('This is the PLAN');
    await expect(planForm).toContainText('does NOT change any job already raised');
    // The picker offers only people the server would accept — the technician
    // (MAINTAINER) is there; the auditor and doc controller are not.
    await expect(planForm.getByRole('option')).toContainText([
      'Nobody — jobs will generate unassigned',
      'Test Technician (MAINTAINER)',
    ]);
    await planForm.getByLabel('Technician').selectOption({ value: E2E_USERS.technician.id });
    await planForm.getByRole('button', { name: 'Save who normally does this' }).click();

    // Slice 33-APPLYDEFAULT — a job for this plan is already raised and
    // unassigned, so the planner is now told and asked. DECLINED here, which
    // is what makes the rest of this journey a proof rather than a
    // coincidence: the plan-only behaviour is exactly what the owner saw, and
    // it must still be available on purpose.
    const offer = page.getByTestId('apply-default-offer');
    await expect(offer).toContainText('1 unassigned job already exists for this plan');
    await offer.getByRole('button', { name: /Leave it unassigned/ }).click();

    await expect(page.getByText(/now normally does/)).toBeVisible();
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    await expect(detail.getByTestId('default-assignee-name')).toContainText('Test Technician');

    // The plan changed; the job that already exists did NOT move — the
    // planner declined, and declining means nothing happened.
    await expect(detail.getByTestId('job-assignee-none')).toBeVisible();

    // ---- level 2: THIS OCCURRENCE. Somebody else covers it.
    await detail.getByRole('button', { name: new RegExp(`Assign job ${job.jobNumber}`) }).click();
    const jobForm = page.getByRole('form', { name: new RegExp(`Assign job ${job.jobNumber}`) });
    await expect(jobForm).toContainText('THIS JOB ONLY');
    await expect(jobForm).toContainText('does NOT change who normally does this maintenance');
    await jobForm.getByLabel('Technician').selectOption({ value: E2E_USERS.teamLeader.id });
    await jobForm.getByRole('button', { name: 'Assign this job' }).click();

    await expect(page.getByText(`Job ${job.jobNumber} assigned.`)).toBeVisible();

    // THE WHOLE POINT: two different answers, both true, neither overwritten.
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    await expect(detail.getByTestId('default-assignee-name')).toContainText('Test Technician');
    await expect(detail.getByTestId('job-assignee-name')).toContainText('Test Team Leader');
  });

  /**
   * SLICE 33-APPLYDEFAULT — THE DAY-ONE GAP, WALKED END TO END.
   *
   * What actually happened: the owner set "who normally does this" on four
   * plans, logged in as the technician, and saw nothing. 4 rules carried a
   * default, 0 jobs were assigned, 195 were unassigned. Nothing was broken —
   * the standing assignee only applies to jobs raised from then on — but the
   * panel explained that only in terms of what it would NOT do, so a planner
   * who did the sensible thing was left with no next step.
   *
   * This is the journey that closes it, and the assertions are deliberately
   * about the OTHER plan's job as much as this one's: the offer is scoped to
   * ONE schedule rule, and a batch that swept up the machine's other plans
   * would be a far worse bug than the one it fixes.
   */
  test('a planner sets the standing assignee and hands it the jobs that are already sitting there', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
    });
    // Two jobs on THIS plan: one nobody holds, one the team leader already
    // has. Only the first may move.
    const free = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M1',
      dueOn: `${YEAR}-09-17`,
      assetCode: 'AW01',
    });
    const held = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M1',
      dueOn: `${YEAR}-10-17`,
      assetCode: 'AW01',
    });
    server.setJobAssignee(held.id, E2E_USERS.teamLeader.id);

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();

    const detail = page.getByTestId('planner-detail');
    await detail.getByRole('button', { name: /Set who normally does/ }).click();
    const planForm = page.getByRole('form', { name: /Set who normally does/ });
    await planForm.getByLabel('Technician').selectOption({ value: E2E_USERS.technician.id });
    await planForm.getByRole('button', { name: 'Save who normally does this' }).click();

    // THE SENTENCE THE OWNER NEVER GOT. One job, not two: the one the team
    // leader already holds is deliberately not in the count.
    const offer = page.getByTestId('apply-default-offer');
    await expect(offer).toContainText('1 unassigned job already exists for this plan');
    await expect(offer).toContainText('Also assign it to Test Technician?');
    await expect(offer).toContainText('Only jobs nobody holds are counted');

    await offer.getByRole('button', { name: /Also assign this job to Test Technician/ }).click();

    await expect(page.getByText(/already raised for it is now theirs/)).toBeVisible();

    // The unassigned job is now the technician's, through the real assign
    // path — the fake mirrors SCHEDULED -> ASSIGNED for exactly this reason.
    expect(server.jobAssigneeOf(free.id)).toBe(E2E_USERS.technician.id);
    // AND THE ONE SOMEBODY ALREADY HELD IS UNTOUCHED. This is the property
    // the non-cascading default exists to protect; the new offer must not be
    // a back door to breaking it.
    expect(server.jobAssigneeOf(held.id)).toBe(E2E_USERS.teamLeader.id);

    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    await expect(detail.getByTestId('job-assignee-name')).toContainText('Test Technician');
  });

  /**
   * The lapse. A standing assignee set while they were eligible, who then
   * loses it — the next sweep raises the job UNASSIGNED rather than refusing,
   * so the planner has to be told BEFORE that happens.
   */
  test('warns when the standing assignee can no longer be assigned to that machine', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
    });
    const rule = server.scheduleRuleFor(doc.id, 'M1');
    server.setRuleDefaultAssignee(rule.id, E2E_USERS.technician.id);

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    // While still eligible, nothing is claimed.
    await expect(page.getByTestId('default-assignee-lapsed')).toHaveCount(0);

    // The technician leaves the company.
    server.deactivateUser(E2E_USERS.technician.id);
    await page.reload();
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();

    const warning = page.getByTestId('default-assignee-lapsed');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Test Technician');
    await expect(warning).toContainText('will arrive UNASSIGNED');
  });

  /**
   * The picker's promise is that it never offers somebody the server would
   * refuse — so the server has to actually refuse. Review finding: the fake's
   * job-level assign accepted anyone who merely existed, so a regression that
   * widened the picker would have passed green. Driven through the real UI:
   * an AUDITOR must not be offered, and must be refused if one is sent anyway.
   */
  test('the job-level picker offers only people the server will accept', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
    });
    const job = server.seedGeneratedJob({
      assetDocumentId: doc.id,
      frequency: 'M1',
      dueOn: `${YEAR}-09-17`,
      assetCode: 'AW01',
    });

    await signInAs(page, E2E_USERS.teamLeader.email);
    await page.goto('/planner');
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();
    await page
      .getByTestId('planner-detail')
      .getByRole('button', { name: new RegExp(`Assign job ${job.jobNumber}`) })
      .click();

    const form = page.getByRole('form', { name: new RegExp(`Assign job ${job.jobNumber}`) });
    // Result-recording roles only. The ADMIN is the pointed exclusion: they
    // may DECIDE who does the work (`@Roles()` on assign) but hold no role
    // that can RECORD it, so assigning to them would be a dead end — and they
    // are the one canned user who tests that distinction.
    await expect(form.getByRole('option')).toContainText(['Test Technician (MAINTAINER)']);
    await expect(form.getByRole('option', { name: /Administrator/ })).toHaveCount(0);

    // ...and the server would refuse one anyway, which is what makes the
    // picker's promise worth anything rather than a client-side courtesy.
    const refusal = await page.evaluate(async (jobId) => {
      const res = await fetch(`/api/v1/jobs/${jobId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-token-user-2' },
        body: JSON.stringify({ assigneeId: 'user-5' }),
      });
      return res.status;
    }, job.id);
    expect(refusal).toBe(422);
  });

  test('a maintainer sees who holds the work but is offered no way to change it', async ({
    page,
    server,
  }) => {
    const machine = server.seedAsset({
      code: 'AW01',
      assetTypeId: 'at-1',
      scheduleAnchorDate: `${YEAR}-09-17`,
    });
    const doc = server.seedAssetDocument({
      assetId: machine.id,
      formTemplateId: E2E_TEMPLATES.wireBond,
    });
    const rule = server.scheduleRuleFor(doc.id, 'M1');
    server.setRuleDefaultAssignee(rule.id, E2E_USERS.technician.id);

    await signInAs(page, E2E_USERS.technician.email);
    await page.goto('/planner');
    await page.getByRole('button', { name: /AW01.*WW38/ }).click();

    const detail = page.getByTestId('planner-detail');
    await expect(detail.getByTestId('default-assignee-name')).toContainText('Test Technician');
    // Reading the plan is not planning it.
    await expect(detail.getByRole('button', { name: /who normally does/ })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: /Assign job/ })).toHaveCount(0);
  });
});
