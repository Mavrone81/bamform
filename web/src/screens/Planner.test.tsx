/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * Slice 31-PLANNER — the cross-machine year grid that replaces
 * `ML-S-MFT-00015`.
 *
 * What is worth pinning here, in order of what would hurt most if it broke:
 *
 *  1. THE WRITE PATH IS SHARED. The grid must move a visit through the same
 *     `adjustAssetSchedule` call, with the same mandatory ten-character
 *     reason, that `MachineSchedule` uses. Two editors would eventually
 *     disagree about the reason floor, and the audit trail is the thing that
 *     would quietly lose.
 *  2. ONLY THE STORED DATE IS EDITABLE. Later cells are projections of
 *     `nextDueOn`; offering an editor on one would move the whole rule and
 *     skip every visit in between.
 *  3. LOAD IS WEIGHTED BY THE CASCADE, not by counting cells.
 *  4. PAST DUE IS NEVER COLOUR ALONE (A-05).
 */

const listAssetTypes = vi.fn();
const listAllPlannerSchedule = vi.fn();
const adjustAssetSchedule = vi.fn();
// Slice 32-PLANNERJOB — the assignment surface.
const listAssignableUsers = vi.fn();
const setScheduleDefaultAssignee = vi.fn();
const assignJob = vi.fn();
const navigate = vi.fn();

vi.mock('../api/admin-client', () => ({
  listAssetTypes: (...args: unknown[]) => listAssetTypes(...args),
  listAllPlannerSchedule: (...args: unknown[]) => listAllPlannerSchedule(...args),
  adjustAssetSchedule: (...args: unknown[]) => adjustAssetSchedule(...args),
  listAssignableUsers: (...args: unknown[]) => listAssignableUsers(...args),
  setScheduleDefaultAssignee: (...args: unknown[]) => setScheduleDefaultAssignee(...args),
  assignJob: (...args: unknown[]) => assignJob(...args),
}));
vi.mock('../router', () => ({ useRouter: () => ({ navigate, path: '/planner' }) }));

const getCurrentUser = vi.fn();
const onCurrentUserChange = vi.fn();
vi.mock('../auth', () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  onCurrentUserChange: (...args: unknown[]) => onCurrentUserChange(...args),
}));

// Imported AFTER the mocks so the screen binds to them.
import { Planner, buildGrid, describeOverdueElsewhere, heavyThresholdFor } from './Planner';
import type { PlannerScheduleRow } from '../api/admin-client';

/**
 * The clock is pinned. "Past due" is `nextDueOn < today`, and the screen
 * defaults its year to the current one — so without this, whether a fixture
 * dated 19 March is late would depend on the month the suite happened to run
 * in, and the overdue assertions would pass all summer and fail in February.
 * Midday UTC so no plausible host timezone shifts the day across a boundary
 * that any assertion here is within a week of.
 */
const NOW = new Date('2026-08-03T12:00:00.000Z');
const YEAR = 2026;

function rule(overrides: Partial<PlannerScheduleRow> = {}): PlannerScheduleRow {
  return {
    id: 'rule-1',
    assetId: 'asset-1',
    assetCode: 'AW01',
    assetDescription: 'Wire bonder, bay 3',
    areaId: 'area-1',
    assetDocumentId: 'doc-1',
    documentNumber: 'CE 95 020 00 03',
    documentTitle: 'KNS Wire Bond Preventive Maintenance Record KW13',
    frequency: 'M3',
    intervalMonths: 3,
    nextDueOn: `${YEAR}-03-19`,
    lastCompletedOn: null,
    adjustedReason: null,
    active: true,
    plannedDates: [`${YEAR}-03-19`, `${YEAR}-06-19`, `${YEAR}-09-19`, `${YEAR}-12-19`],
    cascadeFrequencies: ['M1', 'M3'],
    // Slice 32-PLANNERJOB. The DEFAULT fixture has no job: the pinned clock is
    // 3 August and the next due date is 19 March, which the server would only
    // ever report a job for if one had actually been raised. Every existing
    // assertion in this file therefore keeps meeting the "no job" branch,
    // which is the honest default for a rule that has not reached its
    // generation window.
    nextDueJob: null,
    // Slice 32-PLANNERJOB — no standing assignee, which is the state every one
    // of the plant's 220 rules is in today: jobs generate unassigned.
    defaultAssignee: null,
    // 30 days before 19 March — the default lead time, as the server computes
    // it. Never re-derived here; the client cannot know the lead time.
    jobGenerationOpensOn: `${YEAR}-02-17`,
    ...overrides,
  };
}

/** A rule whose stored next-due visit HAS a generated job. */
function ruleWithJob(overrides: Partial<PlannerScheduleRow> = {}): PlannerScheduleRow {
  return rule({
    nextDueJob: {
      id: 'job-1',
      jobNumber: 'PM-2026-000123',
      status: 'SCHEDULED',
      assignedTo: null,
      assignedToName: null,
    },
    ...overrides,
  });
}

function seed(rows: PlannerScheduleRow[] = [rule()], roles = ['PLANNER']) {
  listAssetTypes.mockResolvedValue({
    ok: true,
    status: 200,
    value: { data: [{ id: 'at-1', code: 'WB', name: 'Wire Bonder', active: true }] },
  });
  listAllPlannerSchedule.mockResolvedValue({ ok: true, status: 200, value: rows });
  getCurrentUser.mockReturnValue({ id: 'u-1', fullName: 'Pat Planner', roles });
  onCurrentUserChange.mockReturnValue(() => {});
  // The candidate list the SERVER filters — never filtered again here. It is
  // the same list for both assignment levels, because the server judges both
  // against the same machine's area.
  listAssignableUsers.mockResolvedValue({
    ok: true,
    status: 200,
    value: {
      data: [
        { id: 'tech-1', fullName: 'Sam Maintainer', roles: ['MAINTAINER'] },
        { id: 'tech-2', fullName: 'Bo Engineer', roles: ['ENGINEER'] },
      ],
      page: { hasMore: false, nextCursor: null, limit: 100 },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // `shouldAdvanceTime` keeps `waitFor` and the screen's own focus-after-open
  // `setTimeout(…, 0)` working under a pinned clock.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function renderGrid() {
  render(<Planner />);
  await screen.findByRole('table');
}

describe('Planner — the grid', () => {
  it('asks the server for exactly the plan year, 1 January to 31 December', async () => {
    await renderGrid();
    expect(listAllPlannerSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ from: `${YEAR}-01-01`, to: `${YEAR}-12-31` }),
    );
  });

  it('offers 52 work-week columns, each naming its week AND its start date', async () => {
    await renderGrid();
    const columnHeaders = screen.getAllByRole('columnheader');
    // 52 weeks plus the machine column.
    expect(columnHeaders).toHaveLength(53);
    expect(columnHeaders[1]).toHaveTextContent('WW01');
    expect(columnHeaders[1]).toHaveTextContent('1 Jan');
    expect(columnHeaders[52]).toHaveTextContent('WW52');
  });

  it('puts a machine down the side and its visit in the week the date falls in', async () => {
    await renderGrid();
    // 19 March is work week 12 counting sevens from 1 January.
    const cell = screen.getByRole('button', { name: /WW12/ });
    expect(cell).toHaveTextContent('3M');
    expect(cell).toHaveAccessibleName(/AW01 CE 95 020 00 03/);
  });

  it('draws every projected visit of the year, not only the next due date', async () => {
    await renderGrid();
    // Quarterly from 19 March: weeks 12, 25, 38 and 51.
    for (const week of ['WW12', 'WW25', 'WW38', 'WW51']) {
      expect(screen.getByRole('button', { name: new RegExp(week) })).toBeInTheDocument();
    }
  });

  it('scrolls the grid inside its own keyboard-reachable region, never the page', async () => {
    await renderGrid();
    const region = screen.getByRole('region', { name: /Machines down the side/ });
    expect(region).toHaveClass('planner-scroll');
    // A scrollable area a keyboard cannot reach is a WCAG 2.1.1 failure.
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('surfaces a server refusal verbatim instead of drawing an empty plan', async () => {
    listAllPlannerSchedule.mockResolvedValue({
      ok: false,
      status: 403,
      problem: { title: 'Forbidden', detail: 'Out of scope.' },
    });
    render(<Planner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Out of scope.');
  });

  it('distinguishes no connection from a refusal', async () => {
    listAllPlannerSchedule.mockResolvedValue({ ok: false, status: 0 });
    render(<Planner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a connection/);
  });
});

describe('Planner — past due is never colour alone (A-05)', () => {
  it('marks an overdue visit with an icon, the word LATE, and its accessible name', async () => {
    seed([rule({ nextDueOn: `${YEAR}-01-05`, plannedDates: [`${YEAR}-01-05`] })]);
    await renderGrid();

    const cell = screen.getByRole('button', { name: /WW01/ });
    expect(cell).toHaveTextContent('LATE');
    expect(cell).toHaveAccessibleName(/past due/);
    // The icon is present and hidden from the accessible name (the words
    // carry it), which is the pairing A-05 asks for.
    expect(cell.querySelector('[aria-hidden="true"]')?.textContent?.trim().length).toBeGreaterThan(
      0,
    );
  });

  it('announces how many visits are past due, and why the rest of the line is not the plan', async () => {
    seed([rule({ nextDueOn: `${YEAR}-01-05`, plannedDates: [`${YEAR}-01-05`] })]);
    await renderGrid();
    const banner = screen.getByTestId('planner-overdue-banner');
    expect(banner).toHaveTextContent('1 visit is past due');
    expect(banner).toHaveTextContent(/follow from its date/);
  });

  it('says nothing about overdue work when there is none', async () => {
    seed([rule({ nextDueOn: `${YEAR}-12-19`, plannedDates: [`${YEAR}-12-19`] })]);
    await renderGrid();
    expect(screen.queryByTestId('planner-overdue-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('planner-overdue-elsewhere')).not.toBeInTheDocument();
  });
});

/**
 * Review I-2. The banner and the LATE markers must not disagree: an alert on
 * `role="alert"` announcing a visit that has no cell on screen is an alarm
 * the planner cannot see or act on.
 *
 * The subtlety is that "count only what is drawn" alone would be WORSE. A
 * rule whose stored date fell in an earlier year is still returned (its date
 * is before the window's end) and still projects visits into this year, so
 * its row looks entirely ordinary — the most neglected line on the plan
 * would become the only silent one. Hence two counts, and the second names
 * the machines and points at the screen that can move them.
 */
describe('Planner — the overdue banner counts only what it can point at', () => {
  /** Stored date in a PRIOR year; projections land inside the displayed one. */
  const straddling = () =>
    rule({
      id: 'rule-straddle',
      assetCode: 'AW09',
      nextDueOn: `${YEAR - 1}-11-01`,
      intervalMonths: 3,
      plannedDates: [`${YEAR}-02-01`, `${YEAR}-05-01`, `${YEAR}-08-01`, `${YEAR}-11-01`],
    });

  it('does not put an off-grid visit in the on-grid count', () => {
    const { overdueCount, overdueElsewhere } = buildGrid([straddling()], YEAR, `${YEAR}-08-03`);
    expect(overdueCount).toBe(0);
    expect(overdueElsewhere).toHaveLength(1);
  });

  it('marks no cell LATE for it — because none of its cells is the stored date', async () => {
    seed([straddling()]);
    await renderGrid();
    expect(screen.queryByText('LATE')).not.toBeInTheDocument();
    // ...and the on-grid banner, which promises "marked LATE below", is absent.
    expect(screen.queryByTestId('planner-overdue-banner')).not.toBeInTheDocument();
  });

  it('still refuses to stay silent: it names the machine, the date and where to act', async () => {
    seed([straddling()]);
    await renderGrid();
    const banner = screen.getByTestId('planner-overdue-elsewhere');
    expect(banner).toHaveTextContent('1 visit is past due');
    expect(banner).toHaveTextContent(`before ${YEAR}`);
    expect(banner).toHaveTextContent(/no cell on this plan/);
    // Where it is...
    expect(banner).toHaveTextContent('AW09 CE 95 020 00 03');
    expect(banner).toHaveTextContent(`1 Nov ${YEAR - 1}`);
    // ...and how to reach it.
    expect(within(banner).getByRole('button', { name: 'Machine schedules' })).toBeInTheDocument();
  });

  it('navigates to the screen that can actually move it', async () => {
    seed([straddling()]);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: 'Machine schedules' }));
    expect(navigate).toHaveBeenCalledWith('/schedule');
  });

  it('keeps the two counts apart when both kinds are present', async () => {
    seed([
      straddling(),
      rule({
        id: 'rule-here',
        assetCode: 'AW01',
        nextDueOn: `${YEAR}-01-05`,
        plannedDates: [`${YEAR}-01-05`],
      }),
    ]);
    await renderGrid();
    expect(screen.getByTestId('planner-overdue-banner')).toHaveTextContent('1 visit is past due');
    expect(screen.getByTestId('planner-overdue-elsewhere')).toHaveTextContent(
      '1 visit is past due',
    );
  });

  /**
   * The case the reviewer described: today 2026-08-03, step to 2027. A rule
   * overdue at 2026-07-01 has no 2027 cell, so the old banner announced a
   * past-due visit that was nowhere on screen.
   */
  it('does not raise an on-grid alarm for a visit left behind in a previous view', async () => {
    seed([
      rule({
        nextDueOn: `${YEAR}-07-01`,
        intervalMonths: 12,
        plannedDates: [`${YEAR}-07-01`, `${YEAR + 1}-07-01`],
      }),
    ]);
    await renderGrid();
    expect(screen.getByTestId('planner-overdue-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Show ${YEAR + 1}` }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(String(YEAR + 1)),
    );
    // No cell of the 2027 grid is that stored date, so nothing claims to be
    // marked LATE there...
    expect(screen.queryByTestId('planner-overdue-banner')).not.toBeInTheDocument();
    // ...but it is not swallowed either.
    expect(screen.getByTestId('planner-overdue-elsewhere')).toHaveTextContent(`1 Jul ${YEAR}`);
  });

  describe('naming stays readable when a plant has let many go stale', () => {
    function stale(n: number) {
      return Array.from({ length: n }, (_, i) =>
        rule({
          id: `stale-${i}`,
          assetId: `asset-${i}`,
          assetCode: `AW${String(i).padStart(2, '0')}`,
          assetDocumentId: `doc-${i}`,
          nextDueOn: `${YEAR - 1}-0${(i % 9) + 1}-01`,
          plannedDates: [`${YEAR}-06-01`],
        }),
      );
    }

    it('names up to three, oldest first, then counts the rest', () => {
      const { overdueElsewhere } = buildGrid(stale(6), YEAR, `${YEAR}-08-03`);
      const text = describeOverdueElsewhere(overdueElsewhere);
      expect(text).toContain('and 3 more');
      // Oldest first: January before February.
      expect(text.indexOf('AW00')).toBeLessThan(text.indexOf('AW01'));
      expect(text.split('),').length).toBe(3);
    });

    it('does not say "and 0 more" at exactly three', () => {
      const { overdueElsewhere } = buildGrid(stale(3), YEAR, `${YEAR}-08-03`);
      expect(describeOverdueElsewhere(overdueElsewhere)).not.toContain('more');
    });
  });
});

describe('Planner — load per week, weighted by the frequency cascade', () => {
  /**
   * The point of the whole load row. A yearly visit carries the 6M, 3M and 1M
   * items too, so one Y cell outweighs three separate 1M cells. Counting
   * cells would say the opposite.
   */
  it('weighs a visit by what it actually carries, not by counting cells', () => {
    const yearly = rule({
      id: 'r-y',
      frequency: 'Y',
      intervalMonths: 12,
      cascadeFrequencies: ['M1', 'M3', 'M6', 'Y'],
      nextDueOn: `${YEAR}-01-05`,
      plannedDates: [`${YEAR}-01-05`],
    });
    const monthly = rule({
      id: 'r-m',
      assetDocumentId: 'doc-2',
      documentNumber: 'CE 95 012 00 01',
      frequency: 'M1',
      intervalMonths: 1,
      cascadeFrequencies: ['M1'],
      nextDueOn: `${YEAR}-01-12`,
      plannedDates: [`${YEAR}-01-12`],
    });

    const { loadByWeek } = buildGrid([yearly, monthly], YEAR, `${YEAR}-01-01`);
    expect(loadByWeek.get(1)).toBe(4); // the annual, carrying four frequencies
    expect(loadByWeek.get(2)).toBe(1); // one monthly
  });

  it('shows the load figure for a week as a number, not only as a bar', async () => {
    await renderGrid();
    const loadRow = screen.getByRole('row', { name: /Load/ });
    // The bar is decoration; these are the values a planner reads.
    expect(within(loadRow).getAllByText('2').length).toBeGreaterThan(0);
  });

  it('flags a week carrying far more than its neighbours, in words as well as shape', async () => {
    const heavy = [
      rule({ id: 'a', nextDueOn: `${YEAR}-02-02`, plannedDates: [`${YEAR}-02-02`] }),
      rule({
        id: 'b',
        assetId: 'asset-2',
        assetCode: 'AW02',
        assetDocumentId: 'doc-2',
        nextDueOn: `${YEAR}-02-03`,
        plannedDates: [`${YEAR}-02-03`],
      }),
      rule({
        id: 'c',
        assetId: 'asset-3',
        assetCode: 'AW03',
        assetDocumentId: 'doc-3',
        nextDueOn: `${YEAR}-02-04`,
        plannedDates: [`${YEAR}-02-04`],
      }),
      rule({
        id: 'd',
        assetId: 'asset-4',
        assetCode: 'AW04',
        assetDocumentId: 'doc-4',
        nextDueOn: `${YEAR}-06-01`,
        plannedDates: [`${YEAR}-06-01`],
      }),
    ];
    seed(heavy);
    await renderGrid();
    // Week 6 (2–4 Feb) carries three visits at weight 2; week 22 carries one.
    expect(screen.getByText(/6 items due, a heavy week/)).toBeInTheDocument();
  });

  describe('the heavy threshold', () => {
    it('is half again the average LOADED week, floored at 2', () => {
      expect(heavyThresholdFor(new Map([[1, 2]]))).toBe(3);
      expect(
        heavyThresholdFor(
          new Map([
            [1, 6],
            [2, 2],
            [3, 2],
            [4, 2],
          ]),
        ),
      ).toBe(5);
    });

    it('never fires on an empty plan', () => {
      expect(heavyThresholdFor(new Map())).toBe(Number.POSITIVE_INFINITY);
    });

    it('does not call a lone single item a heavy week', () => {
      // Without the floor of 2, one item against zero neighbours would alarm.
      expect(heavyThresholdFor(new Map([[1, 1]]))).toBe(2);
    });
  });
});

describe('Planner — rows are machine plus document', () => {
  it('names the document only when a machine carries more than one', () => {
    const single = buildGrid([rule()], YEAR, `${YEAR}-01-01`);
    expect(single.rows).toHaveLength(1);
    expect(single.rows[0].showsDocument).toBe(false);

    const both = buildGrid(
      [
        rule(),
        rule({
          id: 'rule-2',
          assetDocumentId: 'doc-2',
          documentNumber: 'CE 95 012 00 01',
        }),
      ],
      YEAR,
      `${YEAR}-01-01`,
    );
    expect(both.rows).toHaveLength(2);
    expect(both.rows.every((row) => row.showsDocument)).toBe(true);
  });

  it('orders machines by code so the grid reads like the sheet it replaces', () => {
    const { rows } = buildGrid(
      [
        rule({ id: 'z', assetId: 'a-z', assetCode: 'WB20', assetDocumentId: 'd-z' }),
        rule({ id: 'a', assetId: 'a-a', assetCode: 'AW01', assetDocumentId: 'd-a' }),
      ],
      YEAR,
      `${YEAR}-01-01`,
    );
    expect(rows.map((row) => row.assetCode)).toEqual(['AW01', 'WB20']);
  });

  it('ignores a date outside the grid’s year rather than drawing it in the wrong column', () => {
    const { rows, loadByWeek } = buildGrid(
      [rule({ plannedDates: [`${YEAR - 1}-12-19`, `${YEAR}-03-19`] })],
      YEAR,
      `${YEAR}-01-01`,
    );
    expect([...rows[0].byWeek.keys()]).toEqual([12]);
    expect([...loadByWeek.keys()]).toEqual([12]);
  });
});

describe('Planner — selecting a cell, and the one editable date', () => {
  it('opens the visit with its week AND its stored date', async () => {
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));

    const detail = await screen.findByTestId('planner-detail');
    expect(detail).toHaveTextContent('WW12');
    expect(detail).toHaveTextContent('19 Mar');
    expect(detail).toHaveTextContent('KNS Wire Bond Preventive Maintenance Record KW13');
    // What the visit carries, said in words — the reason it outweighs a monthly.
    expect(detail).toHaveTextContent(/Carries 1M \+ 3M items/);
  });

  it('offers the editor on the stored next-due visit', async () => {
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));
    expect(
      await screen.findByRole('button', { name: /Move next due date for/ }),
    ).toBeInTheDocument();
  });

  /**
   * The honest limit. `PUT /assets/{assetId}/schedule` writes `next_due_on`
   * and nothing else, so "move the September cell" would move the whole rule
   * to September and skip June — silently, with an audit entry claiming it
   * was intended.
   */
  it('refuses to offer an editor on a PROJECTED visit, and says why', async () => {
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW38/ }));

    const detail = await screen.findByTestId('planner-detail');
    expect(within(detail).queryByRole('button', { name: /Move next due date/ })).toBeNull();
    expect(detail).toHaveTextContent(/Projected, not stored/);
    expect(detail).toHaveTextContent(/no way to move a single later visit/);
  });

  it('offers no editor at all to a role that cannot adjust — not a disabled one', async () => {
    seed([rule()], ['MAINTAINER']);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));

    await screen.findByTestId('planner-detail');
    expect(screen.queryByRole('button', { name: /Move next due date/ })).toBeNull();
    expect(screen.getByText(/Moving a visit needs a planner/)).toBeInTheDocument();
  });
});

/**
 * Slice 32-PLANNERJOB — the planner reaches the work.
 *
 * The point of these is NOT that a link renders. It is that the link points at
 * the job the server named for THIS visit, that a visit with no job says so
 * instead of offering a dead control, and that no path here ever offers to
 * raise the work by hand — an ad-hoc job carries an empty `frequencyScope`
 * and cannot advance `schedule_rule.next_due_on`, so a planned visit raised
 * that way is recorded off-plan AND leaves the schedule permanently overdue.
 */
describe('Planner — reaching the job for a visit', () => {
  async function openNextDue(rows: PlannerScheduleRow[]) {
    seed(rows);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));
    return screen.findByTestId('planner-detail');
  }

  it('offers the job the server named for this visit, and opens THAT job', async () => {
    const detail = await openNextDue([ruleWithJob()]);

    const open = within(detail).getByRole('button', { name: /Open job PM-2026-000123/ });
    // Named in the visible label too, not only in the accessible name — a
    // planner about to leave the plan should see which record they are opening.
    expect(open).toHaveTextContent('PM-2026-000123');

    fireEvent.click(open);
    // The id the server sent, not one re-derived from the machine or the date.
    expect(navigate).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('opens the right job when two documents on one machine are both due that week', async () => {
    // The exact case a "nearest job on this machine" match would get wrong:
    // one machine, two documents, two rules, two jobs, same due date.
    const wireBond = ruleWithJob({
      id: 'rule-wb',
      assetDocumentId: 'doc-wb',
      documentNumber: 'CE 95 020 00 03',
      frequency: 'M3',
      nextDueJob: {
        id: 'job-wb',
        jobNumber: 'PM-2026-000111',
        status: 'SCHEDULED',
        assignedTo: null,
        assignedToName: null,
      },
    });
    const phMeter = ruleWithJob({
      id: 'rule-ph',
      assetDocumentId: 'doc-ph',
      documentNumber: 'CE 95 012 00 01',
      documentTitle: 'pH Meter Check',
      frequency: 'M1',
      nextDueJob: {
        id: 'job-ph',
        jobNumber: 'PM-2026-000222',
        status: 'ASSIGNED',
        assignedTo: null,
        assignedToName: null,
      },
    });
    seed([wireBond, phMeter]);
    await renderGrid();

    // Two lines under one machine code, so each cell is unambiguous.
    fireEvent.click(screen.getByRole('button', { name: /CE 95 012 00 01.*WW12/ }));
    const detail = await screen.findByTestId('planner-detail');
    fireEvent.click(within(detail).getByRole('button', { name: /Open job PM-2026-000222/ }));
    expect(navigate).toHaveBeenCalledWith('/jobs/job-ph');
    expect(navigate).not.toHaveBeenCalledWith('/jobs/job-wb');
  });

  it('states the job’s status in words, never as a colour (A-05)', async () => {
    const detail = await openNextDue([
      ruleWithJob({
        nextDueJob: {
          id: 'job-1',
          jobNumber: 'PM-2026-000123',
          status: 'IN_PROGRESS',
          assignedTo: null,
          assignedToName: null,
        },
      }),
    ]);
    // The server's own vocabulary, verbatim — this is a controlled-document
    // system and the screen must agree with the audit trail word for word.
    expect(within(detail).getByText('IN_PROGRESS')).toBeInTheDocument();
  });

  it('names the date the scheduler will raise it — the server’s, not one it worked out', async () => {
    seed([
      rule({
        nextDueOn: `${YEAR}-12-19`,
        plannedDates: [`${YEAR}-12-19`],
        // 45 days before the due date, DELIBERATELY not the 30 a client might
        // be tempted to assume: the lead time is per machine type over a
        // server-configured default, so a screen that computed this itself
        // would be wrong for exactly the families that are not the default.
        jobGenerationOpensOn: `${YEAR}-11-04`,
      }),
    ]);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW51/ }));

    const pending = await screen.findByTestId('visit-job-pending');
    expect(pending).toHaveTextContent(`4 Nov ${YEAR}`);
    expect(pending).toHaveTextContent(/nothing to open until then/);
    // No number of days is asserted anywhere in the copy.
    expect(pending.textContent).not.toMatch(/\d+ days/);
  });

  it('does not claim a job is coming when the window has already passed and none was raised', async () => {
    const detail = await openNextDue([
      // Due 19 March, generation opened 17 February — both behind the pinned
      // 3 August. A sweep has had every chance; something is wrong, and
      // "it will appear" would leave a planner watching a cell that never fills.
      rule({ plannedDates: [`${YEAR}-03-19`] }),
    ]);

    const stalled = within(detail).getByTestId('visit-job-overdue-generation');
    expect(stalled).toHaveTextContent(`17 Feb ${YEAR}`);
    expect(stalled).toHaveTextContent(/no current revision, or no active items/);
    expect(within(detail).queryByTestId('visit-job-pending')).toBeNull();
  });

  /**
   * THE TRAP THIS SLICE EXISTS TO AVOID. `POST /jobs/adhoc` creates a job with
   * an EMPTY `frequencyScope`, which is what makes it structurally incapable
   * of advancing `schedule_rule.next_due_on`. Using it for a planned visit
   * would record the work off-plan AND leave this rule overdue for ever.
   */
  it('never offers to raise a planned visit by hand, and says why', async () => {
    const detail = await openNextDue([
      rule({
        nextDueOn: `${YEAR}-12-19`,
        plannedDates: [`${YEAR}-12-19`, `${YEAR}-03-19`],
        jobGenerationOpensOn: `${YEAR}-11-19`,
      }),
    ]);
    expect(within(detail).queryByRole('button', { name: /Raise/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /WW51/ }));
    const pending = await screen.findByTestId('visit-job-pending');
    expect(pending).toHaveTextContent(/would not advance the next due date/);
    expect(pending).toHaveTextContent(/off-plan call-out/);
  });

  /**
   * The consistency the brief asks for: the grid already refuses the adjust
   * form on a projected cell because only `nextDueOn` is stored. The same fact
   * decides the job — generation reads `next_due_on` and nothing else.
   */
  it('says a projected visit has no job and cannot have one, alongside the same refusal to move it', async () => {
    seed([ruleWithJob()]);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW38/ }));

    const detail = await screen.findByTestId('planner-detail');
    // The rule DOES carry a job — for its stored March date. The September
    // projection must not borrow it.
    expect(within(detail).queryByRole('button', { name: /Open job/ })).toBeNull();
    expect(within(detail).getByTestId('visit-job-projected')).toBeInTheDocument();
    // ...and the existing "cannot be moved on its own" refusal is still there,
    // so the two limits are stated from the same fact rather than disagreeing.
    expect(detail).toHaveTextContent(/Projected, not stored/);
  });

  it('offers the job to a role that cannot adjust the schedule — reading work is not planning it', async () => {
    seed([ruleWithJob()], ['MAINTAINER']);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));

    const detail = await screen.findByTestId('planner-detail');
    expect(within(detail).getByRole('button', { name: /Open job PM-2026-000123/ })).toBeVisible();
    expect(within(detail).queryByRole('button', { name: /Move next due date/ })).toBeNull();
  });

  /**
   * The past-due banner used to assert flatly that the visit "has already
   * raised one job". With `nextDueJob` the screen can check, and the whole
   * warning — what saving a new date leaves behind — turns on which it is.
   */
  describe('the past-due warning no longer asserts a job it cannot see', () => {
    const overdue = (overrides: Partial<PlannerScheduleRow> = {}) =>
      rule({
        nextDueOn: `${YEAR}-01-05`,
        plannedDates: [`${YEAR}-01-05`],
        jobGenerationOpensOn: `${YEAR - 1}-12-06`,
        ...overrides,
      });

    it('names the job that is really open, when there is one', async () => {
      seed([
        overdue({
          nextDueJob: {
            id: 'job-1',
            jobNumber: 'PM-2026-000123',
            status: 'SCHEDULED',
            assignedTo: null,
            assignedToName: null,
          },
        }),
      ]);
      await renderGrid();
      fireEvent.click(screen.getByRole('button', { name: /WW01/ }));

      const detail = await screen.findByTestId('planner-detail');
      const banner = within(detail).getByRole('alert');
      expect(banner).toHaveTextContent('Job PM-2026-000123 is already open at this date');
      expect(banner).toHaveTextContent(/raises a SECOND job at the new date/);
    });

    it('does not invent one when the scheduler raised nothing', async () => {
      seed([overdue()]);
      await renderGrid();
      fireEvent.click(screen.getByRole('button', { name: /WW01/ }));

      const detail = await screen.findByTestId('planner-detail');
      const banner = within(detail).getByRole('alert');
      expect(banner).toHaveTextContent('No job has been raised for it');
      // The old, unconditional claim must not come back: it was false for a
      // document with no current revision and for a plant whose sweep is down.
      expect(banner.textContent).not.toMatch(/has already raised one job/);
      // And the consequence stated matches: nothing is stranded at the old date.
      expect(banner).toHaveTextContent(/moves the whole rule cleanly/);
    });
  });
});

describe('Planner — the write goes through the shared editor, not a second copy', () => {
  async function openEditor() {
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Move next due date for/ }));
    return screen.findByRole('form', { name: /Adjust schedule for/ });
  }

  it('holds Save closed until the reason meets the server’s ten-character floor', async () => {
    await openEditor();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'too short' }, // 9 characters
    });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'Levelling week 12 load' },
    });
    expect(save).toBeEnabled();
  });

  it('holds Save closed when the date has been cleared', async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'Levelling week 12 load' },
    });
    fireEvent.change(screen.getByLabelText('Next due date'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends the SAME adjust call the per-machine editor sends, document named', async () => {
    adjustAssetSchedule.mockResolvedValue({ ok: true, status: 200, value: {} });
    await openEditor();

    fireEvent.change(screen.getByLabelText('Next due date'), {
      target: { value: `${YEAR}-04-02` },
    });
    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: '  Levelling week 12 load  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(adjustAssetSchedule).toHaveBeenCalledWith('asset-1', {
        // Always named: a machine can carry two documents at the same
        // frequency, and the server refuses the ambiguous case.
        assetDocumentId: 'doc-1',
        frequency: 'M3',
        nextDueOn: `${YEAR}-04-02`,
        // Trimmed, exactly as the schema's `.trim().min(10)` expects.
        adjustedReason: 'Levelling week 12 load',
      }),
    );
  });

  it('reloads the plan and confirms the move', async () => {
    adjustAssetSchedule.mockResolvedValue({ ok: true, status: 200, value: {} });
    await openEditor();
    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'Levelling week 12 load' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(listAllPlannerSchedule).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Next due date saved for/)).toBeInTheDocument();
  });

  it('surfaces the server’s refusal verbatim and keeps the form open', async () => {
    adjustAssetSchedule.mockResolvedValue({
      ok: false,
      status: 422,
      problem: { title: 'Validation failed', detail: 'This machine carries 2 documents.' },
    });
    const form = await openEditor();
    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'Levelling week 12 load' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Scoped to the form: the page-level overdue banner is also role=alert,
    // and the refusal has to land where the person still has the fields open.
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'This machine carries 2 documents.',
    );
    expect(screen.getByRole('form', { name: /Adjust schedule for/ })).toBeInTheDocument();
  });
});

describe('Planner — the year', () => {
  it('moves to another year and re-reads that window', async () => {
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: `Show ${YEAR + 1}` }));

    await waitFor(() =>
      expect(listAllPlannerSchedule).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: `${YEAR + 1}-01-01`, to: `${YEAR + 1}-12-31` }),
      ),
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(String(YEAR + 1));
  });

  it('narrows to a machine type without leaving the year', async () => {
    await renderGrid();
    fireEvent.change(screen.getByLabelText('Machine type'), { target: { value: 'at-1' } });

    await waitFor(() =>
      expect(listAllPlannerSchedule).toHaveBeenLastCalledWith(
        expect.objectContaining({ assetTypeId: 'at-1', from: `${YEAR}-01-01` }),
      ),
    );
  });

  /**
   * Review I-1. `schedule_rule` holds ONE current next-due date and the
   * server projects it forward only, so a past year returns almost nothing —
   * and the grid would draw a near-empty 2025 for a year in which the plant
   * certainly did maintenance. That reads as "no maintenance was due", which
   * is the dangerous direction. The stepper is floored instead.
   */
  describe('the year only goes forward', () => {
    it('refuses to step below the current year', async () => {
      await renderGrid();
      expect(screen.getByRole('button', { name: `Show ${YEAR - 1}` })).toBeDisabled();
    });

    it('says WHY, rather than leaving a dead control to be discovered', async () => {
      await renderGrid();
      const hint = screen.getByTestId('planner-year-floor');
      expect(hint).toHaveTextContent(/forward plan/);
      expect(hint).toHaveTextContent(/one next-due date per machine/);
      // And it points at where the past actually lives, rather than implying
      // the past does not exist.
      expect(hint).toHaveTextContent(/record archive/);
    });

    it('never re-reads a past window even if the control is driven anyway', async () => {
      await renderGrid();
      fireEvent.click(screen.getByRole('button', { name: `Show ${YEAR - 1}` }));
      // A disabled button dispatches nothing; the guard in the handler is the
      // second lock, and neither may produce a request for a past year.
      expect(listAllPlannerSchedule).toHaveBeenCalledTimes(1);
      expect(listAllPlannerSchedule).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: `${YEAR}-01-01` }),
      );
    });

    it('is still free to go forward, and comes back to the floor', async () => {
      await renderGrid();
      fireEvent.click(screen.getByRole('button', { name: `Show ${YEAR + 1}` }));
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(String(YEAR + 1)),
      );
      // Now stepping back IS allowed — down to, and no further than, the floor.
      expect(screen.getByRole('button', { name: `Show ${YEAR}` })).toBeEnabled();
      expect(screen.queryByTestId('planner-year-floor')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: `Show ${YEAR}` }));
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(String(YEAR)),
      );
      expect(screen.getByRole('button', { name: `Show ${YEAR - 1}` })).toBeDisabled();
    });
  });

  /**
   * Review I-1, second half. The old copy asserted a CAUSE ("A machine
   * schedules work once it carries an active preventive-maintenance
   * document") that this screen cannot know: emptiness could equally be the
   * area scope, the type filter, or everything falling outside the window.
   */
  describe('the empty state does not claim a cause it cannot know', () => {
    it('states what is true and what this screen cannot show', async () => {
      seed([]);
      render(<Planner />);
      const empty = await screen.findByTestId('planner-empty');
      expect(empty).toHaveTextContent(`No maintenance is planned in ${YEAR}`);
      expect(empty).toHaveTextContent(/cannot show visits already carried out/);
      expect(screen.queryByRole('table')).toBeNull();
    });

    it('offers every possible cause as something to CHECK, asserting none', async () => {
      seed([]);
      render(<Planner />);
      const empty = await screen.findByTestId('planner-empty');
      expect(empty).toHaveTextContent(/If you expected something here, check/);
      // All three candidate causes are named; none is stated as the answer.
      expect(empty).toHaveTextContent(/active\s+preventive-maintenance document/);
      expect(empty).toHaveTextContent(new RegExp(`due within ${YEAR}`));
      expect(empty).toHaveTextContent(/area you can see/);
      // The old sentence asserted the document was the reason. It must not
      // come back: this is the exact wording that made the screen lie.
      expect(empty.textContent).not.toMatch(/A machine schedules work once it carries/);
    });

    it('says which filter narrowed it, when one did', async () => {
      seed([]);
      render(<Planner />);
      await screen.findByTestId('planner-empty');
      fireEvent.change(screen.getByLabelText('Machine type'), { target: { value: 'at-1' } });
      await waitFor(() =>
        expect(screen.getByTestId('planner-empty')).toHaveTextContent(
          `No maintenance is planned in ${YEAR} for this machine type`,
        ),
      );
    });
  });
});

/**
 * Slice 32-PLANNERJOB — WHO DOES THE WORK, at two levels.
 *
 * The owner asked for one thing ("allow the assigning or change assigning
 * later") that is really two, and conflating them is the defect these pin:
 *
 *   THE PLAN — `schedule_rule.default_assignee_id`. Who future generated jobs
 *   go to. Must not touch work already raised.
 *   THIS OCCURRENCE — `job.assigned_to`. Who is doing the job that exists.
 *   Must not write back to the plan.
 *
 * A planner covering one visit because somebody is on leave must not silently
 * rewrite who normally does that machine's maintenance — and vice versa. The
 * independence is structural (two endpoints, two columns), so what is worth
 * testing here is that the SCREEN keeps them apart and says which is which.
 */
describe('Planner — assigning the work', () => {
  const withJob = (overrides: Partial<PlannerScheduleRow> = {}) =>
    rule({
      nextDueJob: {
        id: 'job-1',
        jobNumber: 'PM-2026-000123',
        status: 'SCHEDULED',
        assignedTo: null,
        assignedToName: null,
      },
      ...overrides,
    });

  async function openVisit(rows: PlannerScheduleRow[], roles = ['PLANNER']) {
    seed(rows, roles);
    await renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /WW12/ }));
    return screen.findByTestId('planner-detail');
  }

  describe('the two levels are told apart', () => {
    it('shows both, each under its own heading', async () => {
      const detail = await openVisit([
        withJob({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'assignable' },
          nextDueJob: {
            id: 'job-1',
            jobNumber: 'PM-2026-000123',
            status: 'ASSIGNED',
            assignedTo: 'tech-2',
            assignedToName: 'Bo Engineer',
          },
        }),
      ]);

      expect(within(detail).getByRole('heading', { name: 'Who normally does this' })).toBeVisible();
      expect(within(detail).getByRole('heading', { name: 'Who is doing this one' })).toBeVisible();
      // The plan says Sam; this occurrence says Bo. Two answers, both true.
      expect(within(detail).getByTestId('default-assignee-name')).toHaveTextContent(
        'Sam Maintainer',
      );
      expect(within(detail).getByTestId('job-assignee-name')).toHaveTextContent('Bo Engineer');
    });

    it('each control says what it affects BEFORE a name is chosen', async () => {
      const detail = await openVisit([
        withJob({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'assignable' },
        }),
      ]);

      fireEvent.click(within(detail).getByRole('button', { name: /Change who normally does/ }));
      const planForm = await screen.findByRole('form', { name: /Set who normally does/ });
      expect(planForm).toHaveTextContent(/This is the PLAN/);
      expect(planForm).toHaveTextContent(/does NOT change any job already raised/);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(within(detail).getByRole('button', { name: /Assign job PM-2026-000123/ }));
      const jobForm = await screen.findByRole('form', { name: /Assign job PM-2026-000123/ });
      expect(jobForm).toHaveTextContent(/THIS JOB ONLY/);
      expect(jobForm).toHaveTextContent(/does NOT change who normally does this maintenance/);
    });
  });

  describe('changing the plan', () => {
    it('writes the schedule rule and nothing else', async () => {
      setScheduleDefaultAssignee.mockResolvedValue({
        ok: true,
        status: 200,
        value: {
          scheduleRuleId: 'rule-1',
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'assignable' },
        },
      });
      const detail = await openVisit([withJob()]);

      fireEvent.click(within(detail).getByRole('button', { name: /Set who normally does/ }));
      await screen.findByRole('form', { name: /Set who normally does/ });
      fireEvent.change(screen.getByLabelText('Technician'), { target: { value: 'tech-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save who normally does this' }));

      await waitFor(() =>
        expect(setScheduleDefaultAssignee).toHaveBeenCalledWith('rule-1', 'tech-1'),
      );
      // THE POINT: staffing the plan must not touch the job that already
      // exists — that job may be started, and moving it would be a different
      // and much worse feature.
      expect(assignJob).not.toHaveBeenCalled();
    });

    it('can return the plan to nobody, and says what that means', async () => {
      setScheduleDefaultAssignee.mockResolvedValue({
        ok: true,
        status: 200,
        value: { scheduleRuleId: 'rule-1', defaultAssignee: null },
      });
      const detail = await openVisit([
        rule({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'assignable' },
        }),
      ]);

      fireEvent.click(within(detail).getByRole('button', { name: /Change who normally does/ }));
      await screen.findByRole('form', { name: /Set who normally does/ });
      fireEvent.change(screen.getByLabelText('Technician'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save who normally does this' }));

      await waitFor(() => expect(setScheduleDefaultAssignee).toHaveBeenCalledWith('rule-1', null));
      expect(await screen.findByText(/will generate unassigned/)).toBeInTheDocument();
    });

    it('says plainly when nobody is named, and what that costs', async () => {
      const detail = await openVisit([rule()]);
      expect(within(detail).getByTestId('default-assignee-none')).toHaveTextContent(
        /invisible to the technician who should do it/,
      );
    });

    /**
     * THE WARNING THIS SLICE MOST NEEDED. Eligibility lapses silently — a
     * technician leaves, a role is revoked, an area scope is narrowed — and
     * the next sweep then raises the job UNASSIGNED without refusing. Unseen,
     * that is work nobody is holding and nobody can see.
     */
    it('warns when the standing assignee can no longer be assigned here', async () => {
      const detail = await openVisit([
        rule({
          defaultAssignee: {
            id: 'tech-1',
            fullName: 'Sam Maintainer',
            eligibility: 'not-assignable',
          },
        }),
      ]);

      const warning = within(detail).getByTestId('default-assignee-lapsed');
      expect(warning).toHaveTextContent('Sam Maintainer');
      expect(warning).toHaveTextContent(/will arrive UNASSIGNED/);
      // An alert, because it is a state nobody asked to be in and nothing else
      // on the screen would reveal.
      expect(warning).toHaveAttribute('role', 'alert');
    });

    /**
     * REVIEW FINDING — "could not check" must not wear the accusation. The
     * lapsed message names a person and says they lost their role; showing it
     * because a lookup failed would send a planner to replace somebody who
     * never did anything wrong.
     */
    it('says the check did not complete, WITHOUT accusing anyone, when eligibility is unknown', async () => {
      const detail = await openVisit([
        rule({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'unknown' },
        }),
      ]);

      const unknown = within(detail).getByTestId('default-assignee-unknown');
      expect(unknown).toHaveTextContent(/Could not check/);
      expect(unknown).toHaveTextContent(/not a finding about them/);
      expect(unknown).toHaveTextContent(/standing assignment is intact/);
      // The accusing banner must NOT be shown, and its wording must not leak
      // into this one.
      expect(within(detail).queryByTestId('default-assignee-lapsed')).toBeNull();
      expect(unknown.textContent).not.toMatch(/can no longer be assigned/);
      expect(unknown.textContent).not.toMatch(/lost its maintainer/);
      // `status`, not `alert`: nothing has gone wrong with the PLAN, so it must
      // not interrupt the way a real lapse does.
      expect(unknown).toHaveAttribute('role', 'status');
    });

    it('still names the person, so a planner knows which assignment was unverified', async () => {
      const detail = await openVisit([
        rule({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'unknown' },
        }),
      ]);
      expect(within(detail).getByTestId('default-assignee-name')).toHaveTextContent(
        'Sam Maintainer',
      );
      expect(within(detail).getByTestId('default-assignee-unknown')).toHaveTextContent(
        'Sam Maintainer',
      );
    });

    it('says nothing of the sort while the assignee is still eligible', async () => {
      const detail = await openVisit([
        rule({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'assignable' },
        }),
      ]);
      expect(within(detail).queryByTestId('default-assignee-lapsed')).toBeNull();
    });
  });

  describe('assigning this occurrence', () => {
    it('writes the job and nothing else', async () => {
      assignJob.mockResolvedValue({ ok: true, status: 200, value: {} });
      const detail = await openVisit([
        withJob({
          defaultAssignee: { id: 'tech-1', fullName: 'Sam Maintainer', eligibility: 'assignable' },
        }),
      ]);

      fireEvent.click(within(detail).getByRole('button', { name: /Assign job PM-2026-000123/ }));
      await screen.findByRole('form', { name: /Assign job PM-2026-000123/ });
      fireEvent.change(screen.getByLabelText('Technician'), { target: { value: 'tech-2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Assign this job' }));

      await waitFor(() => expect(assignJob).toHaveBeenCalledWith('job-1', 'tech-2'));
      // THE POINT, mirrored: covering one visit must not rewrite the plan.
      expect(setScheduleDefaultAssignee).not.toHaveBeenCalled();
    });

    it('says when a job exists but nobody holds it', async () => {
      const detail = await openVisit([withJob()]);
      expect(within(detail).getByTestId('job-assignee-none')).toHaveTextContent(
        /nobody can see this work at all/,
      );
    });

    it('offers no "nobody" option — a job cannot be un-assigned', async () => {
      const detail = await openVisit([withJob()]);
      fireEvent.click(within(detail).getByRole('button', { name: /Assign job/ }));
      await screen.findByRole('form', { name: /Assign job/ });

      const options = within(screen.getByLabelText('Technician')).getAllByRole('option');
      expect(options[0]).toHaveTextContent('Choose a technician…');
      expect(options.map((o) => o.textContent)).not.toContain(
        expect.stringContaining('generate unassigned'),
      );
      // ...and Save stays shut until a real person is chosen, so the 422 on a
      // missing `assigneeId` is unreachable.
      expect(screen.getByRole('button', { name: 'Assign this job' })).toBeDisabled();
    });

    /**
     * `job-state-machine.ts` allows ASSIGN only from SCHEDULED/ASSIGNED/
     * IN_PROGRESS. A control on a SUBMITTED job would collect a 409
     * `invalid-transition` the planner can do nothing about.
     */
    it.each(['SUBMITTED', 'ARCHIVED', 'VOIDED'])(
      'offers no reassign control on a %s job, and says why',
      async (status) => {
        const detail = await openVisit([
          withJob({
            nextDueJob: {
              id: 'job-1',
              jobNumber: 'PM-2026-000123',
              status: status as PlannerScheduleRow['nextDueJob'] extends null ? never : 'SUBMITTED',
              assignedTo: 'tech-2',
              assignedToName: 'Bo Engineer',
            },
          }),
        ]);

        expect(within(detail).queryByRole('button', { name: /Reassign this job/ })).toBeNull();
        expect(within(detail).getByTestId('job-assignee-locked')).toHaveTextContent(status);
      },
    );

    it('does offer it on an IN_PROGRESS job — that is the deactivated-assignee recovery path', async () => {
      const detail = await openVisit([
        withJob({
          nextDueJob: {
            id: 'job-1',
            jobNumber: 'PM-2026-000123',
            status: 'IN_PROGRESS',
            assignedTo: 'tech-2',
            assignedToName: 'Bo Engineer',
          },
        }),
      ]);
      expect(within(detail).getByRole('button', { name: /Reassign job/ })).toBeVisible();
    });
  });

  describe('the picker only ever offers what the server will accept', () => {
    it('asks the server per RULE, and never filters the answer itself', async () => {
      const detail = await openVisit([withJob()]);
      fireEvent.click(within(detail).getByRole('button', { name: /Set who normally does/ }));
      await screen.findByRole('form', { name: /Set who normally does/ });

      // Keyed by the rule, because the rule exists before the job does — a
      // visit still awaiting generation needs a picker too.
      expect(listAssignableUsers).toHaveBeenCalledWith('rule-1');
      // Every row the server returned is offered, with the roles that put them
      // there. Nothing is dropped locally: the rule spans three tables and a
      // client-side guess would go stale.
      const options = within(screen.getByLabelText('Technician')).getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual([
        'Nobody — jobs will generate unassigned',
        'Sam Maintainer (MAINTAINER)',
        'Bo Engineer (ENGINEER)',
      ]);
    });

    it('uses ONE list for both levels — they cannot disagree about who is eligible', async () => {
      const detail = await openVisit([withJob()]);

      fireEvent.click(within(detail).getByRole('button', { name: /Set who normally does/ }));
      await screen.findByRole('form', { name: /Set who normally does/ });
      const planNames = within(screen.getByLabelText('Technician'))
        .getAllByRole('option')
        .map((o) => o.textContent)
        .slice(1);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      fireEvent.click(within(detail).getByRole('button', { name: /Assign job/ }));
      await screen.findByRole('form', { name: /Assign job/ });
      const jobNames = within(screen.getByLabelText('Technician'))
        .getAllByRole('option')
        .map((o) => o.textContent)
        .slice(1);

      expect(jobNames).toEqual(planNames);
      // The same endpoint answered both — one source, so no drift is possible.
      expect(listAssignableUsers.mock.calls.every(([id]) => id === 'rule-1')).toBe(true);
    });

    it('says so when nobody at all can be assigned, naming the three conditions', async () => {
      const detail = await openVisit([withJob()]);
      // Overridden AFTER `openVisit` — `seed()` installs the default roster.
      listAssignableUsers.mockResolvedValue({
        ok: true,
        status: 200,
        value: { data: [], page: { hasMore: false, nextCursor: null, limit: 100 } },
      });
      fireEvent.click(within(detail).getByRole('button', { name: /Set who normally does/ }));

      const empty = await screen.findByTestId('assignee-none');
      expect(empty).toHaveTextContent(/active user/);
      expect(empty).toHaveTextContent(/maintainer, team leader or engineer/);
      expect(empty).toHaveTextContent(/area scope reaches this machine/);
    });

    it('admits when the roster is longer than one page rather than offering a silent subset', async () => {
      const detail = await openVisit([withJob()]);
      listAssignableUsers.mockResolvedValue({
        ok: true,
        status: 200,
        value: {
          data: [{ id: 'tech-1', fullName: 'Sam Maintainer', roles: ['MAINTAINER'] }],
          page: { hasMore: true, nextCursor: 'c', limit: 100 },
        },
      });
      fireEvent.click(within(detail).getByRole('button', { name: /Set who normally does/ }));
      expect(await screen.findByTestId('assignee-truncated')).toHaveTextContent(/more than this/);
    });

    it('surfaces a server refusal verbatim and keeps the form open', async () => {
      setScheduleDefaultAssignee.mockResolvedValue({
        ok: false,
        status: 422,
        problem: { title: 'Validation failed', detail: 'The assignee holds no role.' },
      });
      const detail = await openVisit([withJob()]);
      fireEvent.click(within(detail).getByRole('button', { name: /Set who normally does/ }));
      const form = await screen.findByRole('form', { name: /Set who normally does/ });
      fireEvent.change(screen.getByLabelText('Technician'), { target: { value: 'tech-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save who normally does this' }));

      expect(await within(form).findByRole('alert')).toHaveTextContent(
        'The assignee holds no role.',
      );
      expect(screen.getByRole('form', { name: /Set who normally does/ })).toBeInTheDocument();
    });
  });

  describe('a role that may not assign', () => {
    it('is offered no control at either level — not a disabled one', async () => {
      const detail = await openVisit(
        [
          withJob({
            defaultAssignee: {
              id: 'tech-1',
              fullName: 'Sam Maintainer',
              eligibility: 'assignable',
            },
          }),
        ],
        ['MAINTAINER'],
      );
      expect(within(detail).queryByRole('button', { name: /who normally does/ })).toBeNull();
      expect(within(detail).queryByRole('button', { name: /Assign job/ })).toBeNull();
      // ...but still SEES who holds the work. Reading the plan is not planning.
      expect(within(detail).getByTestId('default-assignee-name')).toHaveTextContent(
        'Sam Maintainer',
      );
    });
  });

  describe('a projected visit', () => {
    it('shows no assignment panel at all', async () => {
      seed([
        withJob({ defaultAssignee: { id: 'tech-1', fullName: 'Sam', eligibility: 'assignable' } }),
      ]);
      await renderGrid();
      fireEvent.click(screen.getByRole('button', { name: /WW38/ }));

      const detail = await screen.findByTestId('planner-detail');
      // The schedule holds one default per RULE, not one per visit; offering
      // it on a projected cell would invite "set it for December", which the
      // data cannot express.
      expect(within(detail).queryByTestId('visit-assignment')).toBeNull();
    });
  });
});
