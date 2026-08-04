import { useEffect, useState } from 'react';
import { listAssignableUsers, type AssignableUser } from '../api/admin-client';
import { refusalText } from './ScheduleAdjustForm';

export interface AssigneePickerProps {
  /**
   * The rule whose machine decides who is eligible. Both assignment levels
   * use it: the server judges a standing assignee and a job assignee against
   * the SAME machine's area, so one list serves both and cannot disagree with
   * itself. See `GET /schedule/{scheduleRuleId}/assignable-users`.
   */
  scheduleRuleId: string;
  /** Pre-selects the person already holding it, so "no change" is visible. */
  currentAssigneeId: string | null;
  /**
   * Whether "nobody" is a legal choice. TRUE for the rule's standing assignee
   * (`defaultAssigneeId: null` clears it); FALSE for a job, whose
   * `assignJobRequestSchema` requires a uuid — a job is unassigned by never
   * being assigned, and there is no unassign endpoint to offer.
   */
  allowClear: boolean;
  /** Names what is being changed, for the form's accessible name. */
  label: string;
  /**
   * WHAT THIS CHANGE AFFECTS, in the planner's own terms. Mandatory rather
   * than optional: this component is mounted twice on one panel against two
   * different targets, and a picker that did not say which one it was would
   * be the single most dangerous control on the screen.
   */
  affects: React.ReactNode;
  /** Verb on the submit button — "Save" reads as nothing in particular here. */
  saveLabel: string;
  onCancel: () => void;
  /** Resolves to a message on success, or a refusal string to display. */
  onSave: (assigneeId: string | null) => Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * THE ONE ASSIGNEE PICKER — slice 32-PLANNERJOB.
 *
 * Extracted for the reason `ScheduleAdjustForm` was: assignment now happens at
 * TWO levels from ONE panel — who normally does this PM
 * (`schedule_rule.default_assignee_id`) and who is doing this occurrence
 * (`job.assigned_to`) — and two copies of "pick a technician" would drift.
 * The likeliest drift is the candidate list itself, and a picker that offered
 * somebody the server refuses produces a 422 whose detail the planner cannot
 * act on.
 *
 * IT NEVER FILTERS CLIENT-SIDE. The candidates come from
 * `GET /schedule/{scheduleRuleId}/assignable-users`, which the server computes
 * with the SAME predicate `POST /jobs/{jobId}/assign` enforces (active, holds
 * MAINTAINER/TEAM_LEADER/ENGINEER, area scope reaches the machine). That rule
 * spans three tables and changes underneath you — someone leaves, a role is
 * revoked, an area scope is narrowed — so deriving it here would be a guess
 * that goes stale. `GET /users` could not have been used even as a starting
 * point: it is ADMIN-only, and three of the four roles that may assign would
 * have got a 403.
 *
 * A-05: the current holder is marked with a word ("current"), never a colour;
 * every refusal is text.
 */
export function AssigneePicker({
  scheduleRuleId,
  currentAssigneeId,
  allowClear,
  label,
  affects,
  saveLabel,
  onCancel,
  onSave,
}: AssigneePickerProps) {
  const [candidates, setCandidates] = useState<AssignableUser[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [choice, setChoice] = useState<string>(currentAssigneeId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listAssignableUsers(scheduleRuleId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setCandidates(result.value.data);
        // Honest rather than silently short: a site whose roster outgrows one
        // page must say so, not quietly offer the first hundred names as if
        // they were all of them.
        setTruncated(result.value.page.hasMore);
        setError(null);
      } else {
        setCandidates([]);
        setError(refusalText(result.status, result.problem, 'Reading who can be assigned'));
      }
    });
    return () => {
      live = false;
    };
  }, [scheduleRuleId]);

  const fieldId = `assignee-${scheduleRuleId}-${allowClear ? 'default' : 'job'}`;
  const unchanged = (choice || null) === currentAssigneeId;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await onSave(choice ? choice : null);
      if (!result.ok) setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
      aria-label={label}
      className="assignee-picker"
    >
      {/* Stated ABOVE the control, not below it: the planner has to know which
          of the two levels they are about to change before they choose a name,
          not after. */}
      <p className="field-hint">{affects}</p>

      <div className="field">
        <label htmlFor={fieldId}>Technician</label>
        <select
          id={fieldId}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={candidates === null || busy}
        >
          {/*
           * The empty option means two different things and must not pretend
           * otherwise. Where clearing is legal it is a real choice ("nobody");
           * where it is not, it is only the unselected state, and Save stays
           * shut on it via `nothingChosen` below.
           */}
          <option value="">
            {allowClear ? 'Nobody — jobs will generate unassigned' : 'Choose a technician…'}
          </option>
          {(candidates ?? []).map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName} ({user.roles.join(', ')})
              {user.id === currentAssigneeId ? ' — current' : ''}
            </option>
          ))}
        </select>
        {candidates === null && (
          <p className="field-hint">
            <span className="loading-spinner" aria-hidden="true" />
            Loading who can be assigned…
          </p>
        )}
        {candidates !== null && candidates.length === 0 && !error && (
          <p className="field-hint" data-testid="assignee-none">
            <span aria-hidden="true">⚠</span> Nobody can be assigned to this machine. An assignee
            must be an active user holding a maintainer, team leader or engineer role whose area
            scope reaches this machine — check those three before assuming this is a fault.
          </p>
        )}
        {truncated && (
          <p className="field-hint" data-testid="assignee-truncated">
            Showing the first {candidates?.length ?? 0} technicians only — there are more than this
            list can hold.
          </p>
        )}
      </div>

      {error && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary"
          // Shut while nothing has changed (a no-op write would still land an
          // audit event saying a planner changed something), and — where
          // clearing is illegal — while nothing is chosen, which would 422 on
          // `assigneeId` with a detail naming no field.
          disabled={busy || unchanged || (!allowClear && !choice)}
        >
          {saveLabel}
        </button>
      </div>
    </form>
  );
}
