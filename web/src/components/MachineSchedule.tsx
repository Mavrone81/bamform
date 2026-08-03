import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  adjustAssetSchedule,
  getAssetSchedule,
  listAssetDocuments,
  type AssetDocument,
  type Problem,
  type ScheduleRule,
} from '../api/admin-client';
import { getCurrentUser, onCurrentUserChange } from '../auth';
import { rolesCanAdjustSchedule } from '../lib/permissions';
import { todayLocalIsoDate } from '../lib/local-date';
import type { components } from '../api/generated/openapi-types';

type Frequency = components['schemas']['Frequency'];

const FREQUENCY_LABELS: Record<Frequency, string> = {
  M1: 'Monthly (1M)',
  M3: 'Quarterly (3M)',
  M6: 'Half-yearly (6M)',
  Y: 'Yearly',
};

/** Mirrors the server's `.trim().min(10)` on `adjustedReason` exactly
 * (`shared/src/schedule.ts`). Exported so the test can pin it against the
 * real schema instead of a second hand-typed `10` that could drift. */
export const MIN_REASON = 10;

/**
 * Slice 29-SCHEDULE-UI — the missing half of the owner's backfill workflow.
 * `MachineDocuments` lets an admin attach a preventive-maintenance document;
 * this is the ONLY screen that lets anyone set when its work is actually due.
 *
 * THE THING THIS SCREEN EXISTS TO PREVENT: three machines are being migrated
 * deliberately WITHOUT a PM document, so their schedules stay empty until the
 * owner backfills them by hand. `ScheduleRuleBootstrapService` runs on every
 * scheduler sweep — hourly, on by default — and for any machine that just
 * gained an ACTIVE document it creates one `schedule_rule` per template
 * frequency with `nextDueOn = asset.scheduleAnchorDate`. For these three
 * machines that anchor date is in the PAST. `JobGenerationService` raises
 * jobs for anything due within the lead-time window in that SAME sweep. So
 * tagging a document (`MachineDocuments`) does not sit inertly waiting for
 * someone to plan it later — it starts a clock that is already expired, and
 * the next hourly tick raises work against it. Attaching the document and
 * setting real dates here are the SAME SITTING's work, not two separate
 * tasks a week apart. Hence the past-due explanation on each row spells out
 * the CONSEQUENCE, not just that a date looks red.
 *
 * Review IMPORTANT-3 (round 2 — the first attempt at this paragraph got the
 * direction backwards, and the banner disagreed with it): `job` carries a
 * PARTIAL UNIQUE INDEX on `(asset_document_id, frequency_scope, due_on)
 * WHERE status <> 'voided' AND is_adhoc = false`
 * (`20260730000010_job_period_key_by_document_concurrent`), and
 * `JobGenerationService#generateForRule` catches the resulting `P2002` as an
 * idempotent no-op. So a rule left with a past `nextDueOn` raises exactly
 * ONE job, ever — every later sweep re-attempts the SAME `due_on`, collides
 * with the row already there, and reports `alreadyExists`. Leaving it alone
 * does not compound.
 *
 * `adjust()` (`asset-schedule.service.ts`) writes only
 * `nextDueOn`/`adjustedReason` — it never touches that job row. So SAVING A
 * NEW DATE is what creates a SECOND job: the next sweep now attempts a
 * different `due_on`, does not collide with the first, and inserts —
 * leaving the original, still-open job sitting at the old date with nothing
 * pointing back at it. There is no void action anywhere in this web app
 * today — `POST /jobs/{jobId}/void` exists server-side but no screen calls
 * it — so the past-due banner says this plainly (one job already exists;
 * adjusting creates a second; this app cannot void the first) instead of
 * claiming adjusting "stops" anything.
 *
 * `GET /assets/{assetId}/schedule` carries no `@Roles()` — every
 * authenticated user may read it, so this component always renders the list.
 * `PUT` is `PLANNER`/`TEAM_LEADER`/`ENGINEER`/`ADMIN` only
 * (`rolesCanAdjustSchedule`, presentation-only per non-negotiable #6): a
 * caller without one of those roles never sees an edit control at all — not
 * a disabled one that would 403 on click, because the server decides that,
 * not this screen.
 *
 * `assetDocumentId` is ALWAYS sent on the PUT. Since slice 27 a rule hangs
 * off a DOCUMENT, not a machine, so a machine can carry two rules at the same
 * frequency from different documents; the server refuses an ambiguous
 * adjustment rather than guessing which one was meant, and there is no case
 * where omitting it is safer than naming the row actually on screen.
 *
 * Document labels (`resolvedTitle`, `documentNumber`) come from
 * `listAssetDocuments` and are rendered EXACTLY as the server sends them,
 * matching `MachineDocuments`' own convention — nothing here re-derives a
 * title or a due date the server already computed.
 */
export function MachineSchedule({ assetId }: { assetId: string }) {
  const [rules, setRules] = useState<ScheduleRule[] | null>(null);
  const [documents, setDocuments] = useState<AssetDocument[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [user, setUser] = useState(() => getCurrentUser());
  useEffect(() => onCurrentUserChange(setUser), []);
  const canAdjust = rolesCanAdjustSchedule(user?.roles);

  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [draftDate, setDraftDate] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [rowMsg, setRowMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    const [scheduleRes, documentsRes] = await Promise.all([
      getAssetSchedule(assetId),
      listAssetDocuments(assetId),
    ]);
    if (scheduleRes.ok) {
      setRules(scheduleRes.value);
    } else {
      setRules((prev) => prev ?? []);
    }
    if (documentsRes.ok) {
      setDocuments(documentsRes.value.data);
    } else {
      setDocuments((prev) => prev ?? []);
    }

    if (!scheduleRes.ok) {
      setLoadError(
        refusalText(scheduleRes.status, scheduleRes.problem, 'Reading this machine’s schedule'),
      );
      return;
    }
    if (!documentsRes.ok) {
      setLoadError(
        refusalText(
          documentsRes.status,
          documentsRes.problem,
          'Reading the documents this schedule belongs to',
        ),
      );
      return;
    }
    setLoadError(null);
  }, [assetId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function refusalText(status: number, problem?: Problem, what = 'This change'): string {
    if (status === 0) return `Could not reach the server. ${what} needs a connection.`;
    return problem?.detail ?? problem?.title ?? `The server refused this request (${status}).`;
  }

  function banner(msg: { tone: 'good' | 'bad'; text: string } | null) {
    if (!msg) return null;
    return (
      <p className="banner" data-tone={msg.tone} role={msg.tone === 'bad' ? 'alert' : 'status'}>
        <span aria-hidden="true">{msg.tone === 'bad' ? '⚠' : '✓'}</span> {msg.text}
      </p>
    );
  }

  function rowLabel(rule: ScheduleRule, doc: AssetDocument | undefined): string {
    return `${doc?.documentNumber ?? rule.assetDocumentId} ${FREQUENCY_LABELS[rule.frequency]}`;
  }

  function openEdit(rule: ScheduleRule) {
    setRowMsg(null);
    setEditingRuleId(rule.id);
    setDraftDate(rule.nextDueOn);
    setDraftReason('');
  }

  function cancelEdit() {
    setEditingRuleId(null);
    setDraftDate('');
    setDraftReason('');
    setRowMsg(null);
  }

  async function saveAdjustment(
    event: FormEvent,
    rule: ScheduleRule,
    doc: AssetDocument | undefined,
  ) {
    event.preventDefault();
    setBusy(true);
    setRowMsg(null);
    try {
      const result = await adjustAssetSchedule(assetId, {
        // Always sent — see the module doc. Never inferred from "there is
        // only one row on screen right now": the row itself always knows
        // which document it belongs to.
        assetDocumentId: rule.assetDocumentId,
        frequency: rule.frequency,
        nextDueOn: draftDate,
        adjustedReason: draftReason.trim(),
      });
      if (result.ok) {
        setEditingRuleId(null);
        setDraftDate('');
        setDraftReason('');
        setRowMsg({ tone: 'good', text: `Next due date saved for ${rowLabel(rule, doc)}.` });
        await loadAll();
      } else {
        setRowMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  const documentById = new Map((documents ?? []).map((doc) => [doc.id, doc]));
  const reasonTooShort = draftReason.trim().length < MIN_REASON;
  // Review IMPORTANT-1: `<input type="date">` is clearable — a planner
  // retyping the date on a tablet picker can send `nextDueOn: ''`, which
  // fails `z.string().min(1)` (shared/src/schedule.ts) as a 422 whose whole
  // detail is "Request body failed validation.", naming no field. Exactly
  // the state `MachineDocuments.tsx` (review M-1) went out of its way to
  // make unreachable for its own text field; the date field needs the same.
  const dateMissing = draftDate === '';

  return (
    <section aria-labelledby="machine-schedule-heading" className="card">
      <h2 id="machine-schedule-heading">Preventive-maintenance schedule</h2>
      <p className="text-soft">
        One row per frequency per document. A due date left in the past already raised its one job —
        read the warning on that row before changing it, since setting a new date is what raises a
        second.
      </p>

      {!canAdjust && (
        <p className="field-hint">
          You can view this schedule. Adjusting a next-due date needs a planner, team leader,
          engineer or admin role.
        </p>
      )}

      {loadError && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {loadError}
        </p>
      )}

      {rules === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}

      {rules !== null && !loadError && rules.length === 0 && (
        <p className="field-hint">
          No maintenance is currently scheduled for this machine — nothing to adjust yet.
        </p>
      )}

      <ul className="data-list">
        {(rules ?? []).map((rule) => {
          const doc = documentById.get(rule.assetDocumentId);
          // Review MINOR: NOT `!rule.active || !doc.active`. The service's
          // `where` on both GET and PUT (`asset-schedule.service.ts`) already
          // filters to `assetDocument: { active: true }`, so a row belonging
          // to a retired document never reaches this component at all — that
          // half would be dead on arrival and, worse, untestable against a
          // real response. `rule.active` alone is kept: it is on the wire
          // contract (`shared/src/schedule.ts`) and `job-generation.service.ts`
          // honours it, but no writer in the API sets it to `false` today
          // (checked bootstrap/adjust/completion-cascade/void-recompute), so
          // this branch is currently unreachable too — kept for the day
          // something does, not because it fires now.
          const retired = !rule.active;
          const overdue = rule.nextDueOn < todayLocalIsoDate();
          const isEditing = editingRuleId === rule.id;

          return (
            <li key={rule.id}>
              <div className="card">
                <div className="card-row">
                  <span className="card-title">{doc?.resolvedTitle ?? 'Unknown document'}</span>
                  <span className="job-code text-soft">
                    {doc?.documentNumber ?? rule.assetDocumentId}
                  </span>
                </div>

                <div className="card-row">
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">◔</span>
                    <span>{FREQUENCY_LABELS[rule.frequency]}</span>
                  </span>
                  <span className="text-soft">
                    Every {rule.intervalMonths} month{rule.intervalMonths === 1 ? '' : 's'}
                  </span>
                </div>

                {retired && (
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">⊘</span>
                    <span>Retired — no job will be raised from this row</span>
                  </span>
                )}

                <div className="kv-row">
                  <span className="kv-label">Next due</span>
                  <span className="kv-value">{rule.nextDueOn}</span>
                </div>
                <div className="kv-row">
                  <span className="kv-label">Last completed</span>
                  <span className="kv-value">{rule.lastCompletedOn ?? 'Never'}</span>
                </div>
                {rule.adjustedReason && (
                  <div className="kv-row">
                    <span className="kv-label">Adjustment reason</span>
                    <span className="kv-value">{rule.adjustedReason}</span>
                  </div>
                )}

                {/* The hazard this screen exists to prevent, said in terms of
                    what will actually happen — never a bare red dot. Review
                    IMPORTANT-3 (round 2): the causal direction was backwards
                    before — see the module doc's own retelling of it. This
                    now agrees with it: one job already exists against this
                    date and will not repeat on its own; ADJUSTING is what
                    raises a second. There is no void control anywhere in
                    this app to point to, so this says that plainly rather
                    than inventing one. */}
                {overdue && (
                  <p className="banner" data-tone="bad" role="alert">
                    <span aria-hidden="true">⚠</span> This due date has already passed. It has
                    already raised one job — job generation is keyed per due date, so leaving this
                    one as-is will not raise a second. But saving a NEW date here does not remove
                    that job: it stays open at this old date, and the next sweep raises a SECOND job
                    at the new date once it falls due. This app has no control yet to void the first
                    one, so flag it before it is worked as real PM. Set a real date now regardless,
                    in this same sitting — this row's schedule stays wrong until you do.
                  </p>
                )}

                {canAdjust &&
                  (isEditing ? (
                    <form
                      onSubmit={(e) => void saveAdjustment(e, rule, doc)}
                      noValidate
                      aria-label={`Adjust schedule for ${rowLabel(rule, doc)}`}
                    >
                      <div className="field">
                        <label htmlFor={`schedule-date-${rule.id}`}>Next due date</label>
                        <input
                          id={`schedule-date-${rule.id}`}
                          type="date"
                          value={draftDate}
                          onChange={(e) => setDraftDate(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`schedule-reason-${rule.id}`}>Reason for this change</label>
                        <textarea
                          id={`schedule-reason-${rule.id}`}
                          rows={3}
                          value={draftReason}
                          onChange={(e) => setDraftReason(e.target.value)}
                          aria-describedby={`schedule-reason-hint-${rule.id}`}
                        />
                        <p className="field-hint" id={`schedule-reason-hint-${rule.id}`}>
                          Required, at least {MIN_REASON} characters. Recorded permanently in the
                          audit trail.
                        </p>
                      </div>
                      {banner(rowMsg)}
                      <div className="dialog-actions">
                        <button type="button" disabled={busy} onClick={cancelEdit}>
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="btn-primary"
                          disabled={busy || reasonTooShort || dateMissing}
                        >
                          Save
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="dialog-actions">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Adjust next due date for ${rowLabel(rule, doc)}`}
                        onClick={() => openEdit(rule)}
                      >
                        Adjust next due date
                      </button>
                    </div>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>

      {!editingRuleId && banner(rowMsg)}
    </section>
  );
}
