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
 * (`shared/src/schedule.ts`). */
const MIN_REASON = 10;

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

  return (
    <section aria-labelledby="machine-schedule-heading" className="card">
      <h2 id="machine-schedule-heading">Preventive-maintenance schedule</h2>
      <p className="text-soft">
        One row per frequency per document. Setting a next-due date here is what stops the next
        scheduler sweep from raising work against a date that has already passed.
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
          const retired = !rule.active || (doc ? !doc.active : false);
          const overdue = rule.nextDueOn < todayLocalIsoDate();
          const isEditing = editingRuleId === rule.id;

          return (
            <li key={rule.id}>
              <div className="card" data-rule={retired ? 'neutral' : overdue ? 'bad' : 'good'}>
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
                    what will actually happen — never a bare red dot. */}
                {overdue && (
                  <p className="banner" data-tone="bad" role="alert">
                    <span aria-hidden="true">⚠</span> This due date has already passed. The next
                    scheduler sweep (hourly) will raise a job against it as already overdue — set a
                    real date now, in this same sitting, not next week.
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
                          disabled={busy || reasonTooShort}
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
