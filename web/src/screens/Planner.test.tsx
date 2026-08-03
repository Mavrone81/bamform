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
const navigate = vi.fn();

vi.mock('../api/admin-client', () => ({
  listAssetTypes: (...args: unknown[]) => listAssetTypes(...args),
  listAllPlannerSchedule: (...args: unknown[]) => listAllPlannerSchedule(...args),
  adjustAssetSchedule: (...args: unknown[]) => adjustAssetSchedule(...args),
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
    ...overrides,
  };
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
