import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '../router';
import {
  listAllPlannerSchedule,
  listAssetTypes,
  type AssetType,
  type PlannerScheduleRow,
} from '../api/admin-client';
import { getCurrentUser, onCurrentUserChange } from '../auth';
import { rolesCanAdjustSchedule, rolesCanAssignJob } from '../lib/permissions';
import { todayLocalIsoDate } from '../lib/local-date';
import {
  describeWorkWeek,
  formatDayMonth,
  formatFullDate,
  formatWorkWeek,
  workWeekOf,
  workWeekStart,
  workWeeksOfYear,
} from '../lib/work-week';
import {
  FREQUENCY_LABELS,
  FREQUENCY_SHORT,
  ScheduleAdjustForm,
  refusalText,
} from '../components/ScheduleAdjustForm';
import { VisitAssignment } from '../components/VisitAssignment';
import { VisitJobLink } from '../components/VisitJobLink';

/**
 * THE PLANNER GRID — slice 31-PLANNER. The screen that replaces
 * `ML-S-MFT-00015`.
 *
 * The plant plans preventive maintenance on a spreadsheet: 76 machines down
 * the side, 52 work weeks across, a mark in the cell where a visit falls.
 * That layout is not decoration — it IS the plan. It is what makes a year
 * readable at a glance, and it is what lets a planner see that week 12 is
 * carrying four times what week 11 is and move something. A list, however
 * well sorted, cannot show that: load across the year is a SHAPE, and a shape
 * needs two axes.
 *
 * WHAT THIS IS NOT. It is not a second way to write a schedule. Selecting a
 * cell opens `ScheduleAdjustForm` — the same component `MachineSchedule`
 * mounts, calling the same `PUT /assets/{assetId}/schedule` with the same
 * mandatory ten-character reason into the same audit trail. This screen
 * decides WHICH visit is being looked at; it does not own an edit path.
 *
 * WHY ROWS ARE MACHINE + DOCUMENT. The spreadsheet has one row per machine
 * because a machine had one form. Since slice 27 a machine can carry several
 * PM documents (the owner's own example: a wire bonder with both its PM
 * record and a separate pH-meter check), and a rule hangs off the DOCUMENT.
 * Collapsing them into one row would put two independent plans in one line of
 * cells and make "adjust this visit" ambiguous — the exact ambiguity the
 * server refuses at `PUT` time. So a machine with one document reads exactly
 * like the spreadsheet, and a machine with two shows two lines under one
 * machine code.
 *
 * WHY A CELL IS NOT WORTH ONE UNIT OF LOAD. A job's checklist is the union of
 * every frequency whose interval divides its own
 * (`api/src/scheduling/frequency-cascade.ts`), so a yearly visit carries the
 * 6M, 3M and 1M items too. Counting cells would tell a planner that a week of
 * four monthly checks is heavier than a week of three annuals, which is
 * backwards. The load figures below weigh each visit by
 * `cascadeFrequencies.length` — what the server says that visit actually
 * carries, not what this screen guesses from the frequency letter.
 *
 * A-05 THROUGHOUT: every state — past due, heavy week, projected — carries an
 * icon AND words. Nothing here is distinguishable by colour alone.
 */

/** One visit: a rule, on a date, in a week. */
interface PlannerVisit {
  rowKey: string;
  rule: PlannerScheduleRow;
  date: string;
  week: number;
  /** The rule's real `nextDueOn` — the only visit `PUT` can actually move. */
  isNextDue: boolean;
  /** Weight: how many frequencies' items this one visit carries. */
  weight: number;
}

/**
 * A past-due visit whose stored date sits outside the year on screen, so it
 * has no cell to be marked LATE on — review I-2.
 */
interface OverdueElsewhere {
  assetId: string;
  assetCode: string;
  documentNumber: string;
  nextDueOn: string;
}

/** One line of the grid: a machine's document, and its visits by week. */
interface PlannerRow {
  key: string;
  assetId: string;
  assetCode: string;
  assetDescription: string | null;
  documentNumber: string;
  documentTitle: string;
  /** True when this machine has more than one line, so the document is named. */
  showsDocument: boolean;
  byWeek: Map<number, PlannerVisit[]>;
}

export function Planner() {
  const { navigate } = useRouter();
  const [user, setUser] = useState(() => getCurrentUser());
  useEffect(() => onCurrentUserChange(setUser), []);
  const canAdjust = rolesCanAdjustSchedule(user?.roles);
  /**
   * Slice 32-PLANNERJOB — asked SEPARATELY from `canAdjust`, even though the
   * two role lists are identical today. They mirror two different `@Roles()`
   * declarations on two different controllers ("who may move a due date" and
   * "who may hand work to a technician"), and a future narrowing of one must
   * not silently narrow the other. See `lib/permissions.ts`.
   */
  const canAssign = rolesCanAssignJob(user?.roles);

  /**
   * The floor the year stepper cannot go below — see the control's own note.
   * Read once at mount, deliberately: a planner who leaves the tab open
   * across midnight on 31 December should not have the year they are looking
   * at silently become un-navigable underneath them.
   */
  const [earliestYear] = useState(() => new Date().getFullYear());
  const [year, setYear] = useState(earliestYear);
  const [assetTypes, setAssetTypes] = useState<AssetType[] | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [rules, setRules] = useState<PlannerScheduleRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const [selectedCell, setSelectedCell] = useState<{ rowKey: string; week: number } | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void listAssetTypes().then((result) => setAssetTypes(result.ok ? result.value.data : []));
  }, []);

  const load = useCallback(async () => {
    setRules(null);
    const result = await listAllPlannerSchedule({
      // Work week 1 starts 1 January, so the planning year IS the calendar
      // year and the window is exactly one spreadsheet.
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      assetTypeId: typeFilter || undefined,
    });
    if (result.ok) {
      setRules(result.value);
      setLoadError(null);
    } else {
      setRules([]);
      setLoadError(refusalText(result.status, result.problem, 'Reading the maintenance plan'));
    }
  }, [year, typeFilter]);

  useEffect(() => {
    setSelectedCell(null);
    setEditingRuleId(null);
    void load();
  }, [load]);

  const today = todayLocalIsoDate();
  const weeks = workWeeksOfYear();
  const { rows, loadByWeek, heavyThreshold, overdueCount, overdueElsewhere } = useMemo(
    () => buildGrid(rules ?? [], year, today),
    [rules, year, today],
  );

  const selectedRow = rows.find((row) => row.key === selectedCell?.rowKey) ?? null;
  const selectedVisits =
    selectedRow && selectedCell ? (selectedRow.byWeek.get(selectedCell.week) ?? []) : [];

  function openCell(rowKey: string, week: number) {
    setSelectedCell({ rowKey, week });
    setEditingRuleId(null);
    setSavedMessage(null);
    // Keyboard and screen-reader users are moved to the panel they just
    // opened rather than left at the far right of a 52-column table.
    window.setTimeout(() => detailRef.current?.focus(), 0);
  }

  return (
    <main className="app-shell app-shell--wide" aria-labelledby="planner-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/menu')}>
          <span aria-hidden="true">‹</span> Menu
        </button>
        <h1 id="planner-heading">Maintenance plan {year}</h1>
        <p className="screen-meta">
          Every machine's preventive maintenance across the year's 52 work weeks. Work week 1 starts
          1 January. Select a cell to see the visit and, if you plan, move its date.
        </p>
      </header>

      {loadError && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {loadError}
        </p>
      )}
      {savedMessage && (
        <p className="banner" data-tone="good" role="status">
          <span aria-hidden="true">✓</span> {savedMessage}
        </p>
      )}

      <div className="planner-controls">
        <div className="field">
          <label htmlFor="planner-year">Plan year</label>
          <div className="planner-year-control">
            {/*
             * Review I-1 — THE YEAR ONLY GOES FORWARD, and this is a
             * correctness floor, not a preference.
             *
             * `schedule_rule` holds ONE current `next_due_on` per rule and
             * this endpoint projects it FORWARD only, so a past year cannot
             * be reconstructed from it: the query would return only the rules
             * still overdue enough to fall before that year's end, and the
             * grid would draw a near-empty 2025 for a year in which the plant
             * certainly did maintenance. An empty grid reads as "no
             * maintenance was due" — the most dangerous thing this screen
             * could say, and it would be false.
             *
             * Completed work is not missing from the system, it simply lives
             * somewhere else: `job`/`record` rows, reached through the record
             * archive. The hint below says so rather than leaving a dead
             * control to be discovered.
             */}
            <button
              type="button"
              disabled={year <= earliestYear}
              onClick={() => setYear((y) => Math.max(earliestYear, y - 1))}
              aria-label={`Show ${year - 1}`}
            >
              <span aria-hidden="true">‹</span> {year - 1}
            </button>
            <output id="planner-year" className="planner-year-value">
              {year}
            </output>
            <button
              type="button"
              onClick={() => setYear((y) => y + 1)}
              aria-label={`Show ${year + 1}`}
            >
              {year + 1} <span aria-hidden="true">›</span>
            </button>
          </div>
          {year <= earliestYear && (
            <p className="field-hint" data-testid="planner-year-floor">
              This is a forward plan: the system keeps one next-due date per machine, not a record
              of past visits, so earlier years cannot be drawn here. Work that was actually done is
              in the record archive.
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="planner-type">Machine type</label>
          <select
            id="planner-type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            disabled={assetTypes === null}
          >
            <option value="">All types</option>
            {(assetTypes ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!canAdjust && (
        <p className="field-hint">
          You can read the plan. Moving a visit needs a planner, team leader, engineer or admin
          role.
        </p>
      )}

      {/*
       * Review I-2. Two counts, deliberately kept apart, because they need
       * two different things from the reader.
       *
       * `overdueCount` is what is MARKED LATE on the grid below — the planner
       * can see it and click it. It is derived from exactly the condition the
       * cell marker uses, so the banner and the cells cannot disagree.
       *
       * `overdueElsewhere` is the trap: a rule whose stored date fell in an
       * earlier year is still returned and still projects visits into this
       * one, so its row looks perfectly ordinary while being the most
       * neglected line on the plan. It has no cell to mark, so the banner
       * names the machines and points at the screen that CAN move them —
       * an alert nobody can act on would be worse than none.
       */}
      {overdueCount > 0 && (
        <p className="banner" data-tone="bad" role="alert" data-testid="planner-overdue-banner">
          <span aria-hidden="true">⚠</span> {overdueCount} visit
          {overdueCount === 1 ? ' is' : 's are'} past due, marked LATE on the plan below. A past-due
          visit has already raised its job; the later visits drawn on its line follow from its date
          and will all move when it does, so the rest of that line is not the plan until it is dealt
          with.
        </p>
      )}

      {overdueElsewhere.length > 0 && (
        <p className="banner" data-tone="bad" role="alert" data-testid="planner-overdue-elsewhere">
          <span aria-hidden="true">⚠</span> {overdueElsewhere.length} visit
          {overdueElsewhere.length === 1 ? ' is' : 's are'} past due with a date before {year}, so{' '}
          {overdueElsewhere.length === 1 ? 'it has' : 'they have'} no cell on this plan —{' '}
          {describeOverdueElsewhere(overdueElsewhere)}. The later cells on{' '}
          {overdueElsewhere.length === 1 ? 'that line' : 'those lines'} are projected forward from{' '}
          {overdueElsewhere.length === 1 ? 'that date' : 'those dates'} and will move when it is
          set. Open{' '}
          <button type="button" className="btn-quiet" onClick={() => navigate('/schedule')}>
            Machine schedules
          </button>{' '}
          to set a real date.
        </p>
      )}

      {rules === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading the plan…
        </p>
      )}

      {/*
       * Review I-1, second half. This used to say "A machine schedules work
       * once it carries an active preventive-maintenance document" — an
       * assertion of CAUSE that this screen cannot make. Emptiness here has
       * at least four possible causes and the grid can distinguish none of
       * them: no machine carries an active document; every machine does but
       * nothing falls in this window; the caller's area scope excludes the
       * machines that do; or the type filter does. Naming one of them as
       * though it were the answer sends a planner to fix a thing that is not
       * broken, and — worse — implies the plan is genuinely empty.
       *
       * So: state what is true (nothing found, and what this screen can and
       * cannot show), then list what to CHECK. No cause is claimed.
       */}
      {rules !== null && !loadError && rows.length === 0 && (
        <p className="field-hint" data-testid="planner-empty">
          No maintenance is planned in {year}
          {typeFilter ? ' for this machine type' : ''}. This screen shows only work scheduled ahead;
          it cannot show visits already carried out, which are in the record archive. If you
          expected something here, check that those machines carry an active preventive-maintenance
          document, that it is due within {year}, and that they are in an area you can see.
        </p>
      )}

      {rows.length > 0 && (
        <>
          {/*
           * The scroll container, not the page. 52 columns will never fit a
           * tablet, and a page that scrolls sideways loses its own header and
           * navigation off the left edge. `tabindex=0` + `role=region` is what
           * makes a scrollable area reachable and operable by keyboard alone.
           */}
          <div
            className="planner-scroll"
            role="region"
            aria-labelledby="planner-grid-caption"
            tabIndex={0}
          >
            <table className="planner-grid">
              <caption id="planner-grid-caption">
                Machines down the side, work weeks across. Each cell names the frequency of the
                visit that falls in that week.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="planner-corner">
                    Machine
                  </th>
                  {weeks.map((week) => (
                    <th scope="col" key={week} className="planner-week-head">
                      <span className="planner-week-number">{formatWorkWeek(week)}</span>
                      {/* The week is how the planner thinks; the date is what
                          the system stores. Both, always, in every header. */}
                      <span className="planner-week-date">
                        {formatDayMonth(workWeekStart(year, week))}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="planner-load-row">
                  <th scope="row" className="planner-corner">
                    Load
                    <span className="planner-row-sub">items due</span>
                  </th>
                  {weeks.map((week) => {
                    const weekLoad = loadByWeek.get(week) ?? 0;
                    const heavy = weekLoad >= heavyThreshold && weekLoad > 0;
                    return (
                      <td
                        key={week}
                        className="planner-load-cell"
                        data-heavy={heavy ? 'true' : undefined}
                      >
                        <span
                          className="planner-load-bar"
                          style={{ height: `${barHeight(weekLoad, loadByWeek)}%` }}
                          aria-hidden="true"
                        />
                        {/* The number is the accessible value; the bar is the
                            shape. A-05: never the bar alone. */}
                        <span className="planner-load-value">
                          {heavy && (
                            <span aria-hidden="true" className="planner-load-flag">
                              ▲
                            </span>
                          )}
                          {weekLoad || ''}
                        </span>
                        <span className="visually-hidden">
                          {describeWorkWeek(year, week)}: {weekLoad} item
                          {weekLoad === 1 ? '' : 's'} due{heavy ? ', a heavy week' : ''}
                        </span>
                      </td>
                    );
                  })}
                </tr>

                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="planner-corner">
                      <span className="planner-machine-code">{row.assetCode}</span>
                      {row.showsDocument && (
                        <span className="planner-row-sub">{row.documentNumber}</span>
                      )}
                    </th>
                    {weeks.map((week) => {
                      const visits = row.byWeek.get(week) ?? [];
                      if (visits.length === 0) {
                        return <td key={week} className="planner-cell" />;
                      }
                      const lead = heaviest(visits);
                      const late = visits.some((visit) => visit.isNextDue && visit.date < today);
                      const selected =
                        selectedCell?.rowKey === row.key && selectedCell.week === week;
                      return (
                        <td key={week} className="planner-cell">
                          <button
                            type="button"
                            className="planner-visit"
                            data-late={late ? 'true' : undefined}
                            aria-pressed={selected}
                            aria-label={cellLabel(row, visits, lead, week, year, late)}
                            onClick={() => openCell(row.key, week)}
                          >
                            {/* A-05: the state is an icon AND a word, never a
                                colour. The frequency letter is itself a third,
                                colour-independent signal of what the cell is. */}
                            {late && <span aria-hidden="true">⚠</span>}
                            <span className="planner-visit-freq">
                              {FREQUENCY_SHORT[lead.rule.frequency]}
                            </span>
                            {late && <span className="planner-visit-state">LATE</span>}
                            {visits.length > 1 && (
                              <span className="planner-visit-more">+{visits.length - 1}</span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="field-hint">
            {rows.length} line{rows.length === 1 ? '' : 's'} · scroll the grid sideways to reach
            later weeks.
          </p>
        </>
      )}

      {selectedRow && selectedCell && (
        <section
          className="card planner-detail"
          ref={detailRef}
          tabIndex={-1}
          aria-labelledby="planner-detail-heading"
          data-testid="planner-detail"
        >
          <div className="card-row">
            <h2 id="planner-detail-heading">
              {selectedRow.assetCode} · {describeWorkWeek(year, selectedCell.week)}
            </h2>
            <button type="button" className="btn-quiet" onClick={() => setSelectedCell(null)}>
              Close
            </button>
          </div>

          {selectedVisits.map((visit) => {
            const late = visit.isNextDue && visit.date < today;
            const label = `${visit.rule.assetCode} ${visit.rule.documentNumber} ${
              FREQUENCY_LABELS[visit.rule.frequency]
            }`;
            return (
              <div className="card" key={`${visit.rule.id}-${visit.date}`}>
                <div className="card-row">
                  <span className="card-title">{visit.rule.documentTitle}</span>
                  <span className="job-code text-soft">{visit.rule.documentNumber}</span>
                </div>

                <div className="card-row">
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">◔</span>
                    <span>{FREQUENCY_LABELS[visit.rule.frequency]}</span>
                  </span>
                  {/* The cascade, said in words rather than implied by a
                      bigger cell: this is WHY a yearly visit outweighs a
                      monthly one in the load row above. */}
                  <span className="text-soft">
                    Carries{' '}
                    {visit.rule.cascadeFrequencies
                      .map((frequency) => FREQUENCY_SHORT[frequency])
                      .join(' + ')}{' '}
                    items ({visit.weight} of the {visit.rule.intervalMonths}-month cycle)
                  </span>
                </div>

                <div className="kv-row">
                  <span className="kv-label">This visit</span>
                  <span className="kv-value">
                    {formatFullDate(visit.date)} · {formatWorkWeek(visit.week)}
                  </span>
                </div>
                <div className="kv-row">
                  <span className="kv-label">Next due</span>
                  <span className="kv-value">{formatFullDate(visit.rule.nextDueOn)}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-label">Last completed</span>
                  <span className="kv-value">
                    {visit.rule.lastCompletedOn
                      ? formatFullDate(visit.rule.lastCompletedOn)
                      : 'Never'}
                  </span>
                </div>
                {visit.rule.adjustedReason && (
                  <div className="kv-row">
                    <span className="kv-label">Last adjustment</span>
                    <span className="kv-value">{visit.rule.adjustedReason}</span>
                  </div>
                )}

                {/*
                 * Slice 32-PLANNERJOB made this banner ANSWERABLE. It used to
                 * assert flatly that a past-due visit "has already raised one
                 * job" — a claim the screen had no way to check, and which is
                 * simply false where the document carries no current revision
                 * or no items in the rule's scope (`generateForRule` returns
                 * `'skipped'`), or where no sweep has run. `nextDueJob` now
                 * says which it is, so the consequence of saving a new date —
                 * the whole point of the warning — is stated from what is
                 * actually there rather than from an assumption.
                 */}
                {late && (
                  <p className="banner" data-tone="bad" role="alert">
                    <span aria-hidden="true">⚠</span> This due date has already passed.{' '}
                    {visit.rule.nextDueJob ? (
                      <>
                        Job {visit.rule.nextDueJob.jobNumber} is already open at this date — job
                        generation is keyed per due date, so leaving it will not raise a second. But
                        saving a NEW date does not remove that job: it stays open at this old date,
                        and the next sweep raises a SECOND job at the new date once it falls due.
                        This app has no control yet to void the first one, so flag it before it is
                        worked as real PM.
                      </>
                    ) : (
                      <>
                        No job has been raised for it — see below for why that may be. Nothing is
                        left behind at this date, so saving a new one moves the whole rule cleanly.
                      </>
                    )}
                  </p>
                )}

                {/*
                 * THE BRIDGE TO THE WORK — slice 32-PLANNERJOB. Shared with
                 * whatever screen needs it next rather than written inline
                 * here, for the same reason `ScheduleAdjustForm` is: the plan
                 * and the work list must not grow two different accounts of
                 * whether a visit has a job. It also owns the refusal to offer
                 * an ad-hoc raise, which is the mistake this whole link
                 * exists to make unnecessary.
                 */}
                <VisitJobLink
                  job={visit.rule.nextDueJob}
                  isNextDue={visit.isNextDue}
                  jobGenerationOpensOn={visit.rule.jobGenerationOpensOn}
                  today={today}
                  label={label}
                />

                {/*
                 * WHO DOES IT — slice 32-PLANNERJOB, and deliberately BELOW
                 * the job link rather than folded into it. Reaching the work
                 * and staffing it are different questions, and the second one
                 * has two levels (the plan, and this occurrence) that a
                 * planner must be able to tell apart at a glance. That
                 * distinction is the whole reason it is its own component —
                 * see its module note.
                 */}
                <VisitAssignment
                  scheduleRuleId={visit.rule.id}
                  defaultAssignee={visit.rule.defaultAssignee}
                  job={visit.rule.nextDueJob}
                  isNextDue={visit.isNextDue}
                  canAssign={canAssign}
                  label={label}
                  onSaved={async (message) => {
                    setSelectedCell(null);
                    setSavedMessage(message);
                    await load();
                  }}
                />

                {/*
                 * THE HONEST LIMIT OF THIS SCREEN. Only the rule's real
                 * `next_due_on` is a stored date; every later cell on the line
                 * is this year's projection of it (`plannedDates`). `PUT
                 * /assets/{assetId}/schedule` writes `next_due_on` and nothing
                 * else, so "move the November cell" would in fact move the
                 * whole rule to November and skip every visit in between —
                 * silently, with an audit entry claiming it was intended. So
                 * the editor is offered on the next-due cell only, and the
                 * other cells say why rather than pretending to be editable.
                 */}
                {!visit.isNextDue && (
                  <p className="field-hint">
                    <span aria-hidden="true">↻</span> Projected, not stored: this visit follows from
                    the next due date above, every {visit.rule.intervalMonths} month
                    {visit.rule.intervalMonths === 1 ? '' : 's'}. Move the next due date and this
                    one moves with it — there is no way to move a single later visit, because the
                    schedule holds one date per rule, not a list.
                  </p>
                )}

                {canAdjust &&
                  visit.isNextDue &&
                  (editingRuleId === visit.rule.id ? (
                    <ScheduleAdjustForm
                      assetId={visit.rule.assetId}
                      assetDocumentId={visit.rule.assetDocumentId}
                      frequency={visit.rule.frequency}
                      currentNextDueOn={visit.rule.nextDueOn}
                      label={label}
                      onCancel={() => setEditingRuleId(null)}
                      onSaved={async (message) => {
                        setEditingRuleId(null);
                        setSelectedCell(null);
                        setSavedMessage(message);
                        await load();
                      }}
                    />
                  ) : (
                    <div className="dialog-actions">
                      <button
                        type="button"
                        aria-label={`Move next due date for ${label}`}
                        onClick={() => setEditingRuleId(visit.rule.id)}
                      >
                        Move this visit
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- grid maths

/**
 * Turns the flat rule list into the grid. Exported for the unit test: the
 * grouping, the weighting and the heavy-week rule are the parts most worth
 * pinning, and testing them through the rendered table would test the DOM
 * rather than the arithmetic.
 */
export function buildGrid(
  rules: PlannerScheduleRow[],
  year: number,
  today: string,
): {
  rows: PlannerRow[];
  loadByWeek: Map<number, number>;
  heavyThreshold: number;
  /** Past-due visits that ARE drawn on this year's grid, marked LATE. */
  overdueCount: number;
  /**
   * Past-due visits whose stored date falls OUTSIDE the displayed year, so
   * they have no cell here at all — review I-2.
   *
   * These are not a rounding error. A rule whose `nextDueOn` is 1 Nov 2025,
   * read on the 2026 grid, is still returned by the server (its date is
   * before the window's end) and still projects visits INTO 2026 — but the
   * stored date itself has no column, so no cell is marked LATE and the row
   * looks entirely ordinary. Counting only what is drawn would leave the most
   * neglected rules in the plant as the only silent ones; counting them with
   * the rest would put an unactionable alarm on a `role="alert"`. So they are
   * counted separately and NAMED, with the screen that can act on them.
   */
  overdueElsewhere: OverdueElsewhere[];
} {
  const byRow = new Map<string, PlannerRow>();
  const documentsPerAsset = new Map<string, Set<string>>();
  const loadByWeek = new Map<number, number>();
  let overdueCount = 0;
  const overdueElsewhere: OverdueElsewhere[] = [];

  for (const rule of rules) {
    const key = `${rule.assetId}:${rule.assetDocumentId}`;
    let row = byRow.get(key);
    if (!row) {
      row = {
        key,
        assetId: rule.assetId,
        assetCode: rule.assetCode,
        assetDescription: rule.assetDescription ?? null,
        documentNumber: rule.documentNumber,
        documentTitle: rule.documentTitle,
        showsDocument: false,
        byWeek: new Map(),
      };
      byRow.set(key, row);
    }
    const seen = documentsPerAsset.get(rule.assetId) ?? new Set<string>();
    seen.add(rule.assetDocumentId);
    documentsPerAsset.set(rule.assetId, seen);

    // Review I-2: past due is counted against the CELL, not the row. The
    // LATE marker fires for a drawn visit that is the rule's stored
    // `nextDueOn` and has passed; the banner must count exactly that, or it
    // announces visits the planner cannot see or reach.
    if (rule.nextDueOn < today) {
      if (workWeekOf(rule.nextDueOn, year) === null) {
        overdueElsewhere.push({
          assetCode: rule.assetCode,
          assetId: rule.assetId,
          documentNumber: rule.documentNumber,
          nextDueOn: rule.nextDueOn,
        });
      } else {
        overdueCount += 1;
      }
    }

    for (const date of rule.plannedDates) {
      const week = workWeekOf(date, year);
      // A projected date outside the grid's year has no column. The server
      // only sends dates inside the requested window, so this is a guard
      // against a widened window, not an expected branch.
      if (week === null) continue;
      const visit: PlannerVisit = {
        rowKey: key,
        rule,
        date,
        week,
        isNextDue: date === rule.nextDueOn,
        // What the server says this ONE visit carries — never re-derived here
        // from the frequency letter (U-CAS-05: a 3M rule on a document with
        // no 1M rule carries {M3} alone).
        weight: Math.max(rule.cascadeFrequencies.length, 1),
      };
      row.byWeek.set(week, [...(row.byWeek.get(week) ?? []), visit]);
      loadByWeek.set(week, (loadByWeek.get(week) ?? 0) + visit.weight);
    }
  }

  for (const row of byRow.values()) {
    row.showsDocument = (documentsPerAsset.get(row.assetId)?.size ?? 0) > 1;
  }

  const rows = [...byRow.values()].sort(
    (a, b) =>
      a.assetCode.localeCompare(b.assetCode) || a.documentNumber.localeCompare(b.documentNumber),
  );

  // Oldest first — the one that has been waiting longest is the one to name.
  overdueElsewhere.sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn));

  return {
    rows,
    loadByWeek,
    heavyThreshold: heavyThresholdFor(loadByWeek),
    overdueCount,
    overdueElsewhere,
  };
}

/**
 * A week is "heavy" at half again the average of the weeks that carry
 * anything, and never below 2.
 *
 * Deliberately RELATIVE, not a fixed number of items: a plant with 76
 * machines and one with 300 have different normal weeks, and a threshold
 * anyone has to tune is a threshold nobody tunes. Averaging over loaded weeks
 * only (not all 52) stops a plan concentrated in one quarter from declaring
 * every one of its own weeks heavy. The floor of 2 stops "one item where the
 * neighbours have none" reading as an alarm.
 */
export function heavyThresholdFor(loadByWeek: Map<number, number>): number {
  const loaded = [...loadByWeek.values()].filter((value) => value > 0);
  if (loaded.length === 0) return Number.POSITIVE_INFINITY;
  const mean = loaded.reduce((sum, value) => sum + value, 0) / loaded.length;
  return Math.max(2, Math.ceil(mean * 1.5));
}

/**
 * Names the off-grid past-due visits, oldest first, so the banner is
 * actionable rather than a bare count. Capped at three: a plant that has let
 * twenty rules go stale needs the oldest and a total, not a wall of codes.
 */
export function describeOverdueElsewhere(entries: OverdueElsewhere[]): string {
  const named = entries
    .slice(0, 3)
    .map(
      (entry) => `${entry.assetCode} ${entry.documentNumber} (${formatFullDate(entry.nextDueOn)})`,
    )
    .join(', ');
  const rest = entries.length - Math.min(entries.length, 3);
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/** The bar is the shape only — the number beside it is the value. */
function barHeight(weekLoad: number, loadByWeek: Map<number, number>): number {
  const peak = Math.max(1, ...loadByWeek.values());
  return Math.round((weekLoad / peak) * 100);
}

/** The visit that decides what a shared cell shows: the one carrying most. */
function heaviest(visits: PlannerVisit[]): PlannerVisit {
  return visits.reduce((best, visit) => (visit.weight > best.weight ? visit : best), visits[0]);
}

function cellLabel(
  row: PlannerRow,
  visits: PlannerVisit[],
  lead: PlannerVisit,
  week: number,
  year: number,
  late: boolean,
): string {
  const extra = visits.length > 1 ? ` and ${visits.length - 1} more visit(s)` : '';
  return [
    `${row.assetCode} ${row.documentNumber}`,
    `${FREQUENCY_LABELS[lead.rule.frequency]}${extra}`,
    `${describeWorkWeek(year, week)}, due ${formatFullDate(lead.date)}`,
    late ? 'past due' : '',
  ]
    .filter(Boolean)
    .join(', ');
}
