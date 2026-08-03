import { useState, type FormEvent } from 'react';
import { adjustAssetSchedule, type Problem } from '../api/admin-client';
import type { components } from '../api/generated/openapi-types';

type Frequency = components['schemas']['Frequency'];

/** Mirrors the server's `.trim().min(10)` on `adjustedReason` exactly
 * (`shared/src/schedule.ts`). Exported so the test can pin it against the
 * real schema instead of a second hand-typed `10` that could drift. */
export const MIN_REASON = 10;

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  M1: 'Monthly (1M)',
  M3: 'Quarterly (3M)',
  M6: 'Half-yearly (6M)',
  Y: 'Yearly',
};

/** Compact form, for a grid cell where the full words will not fit. */
export const FREQUENCY_SHORT: Record<Frequency, string> = {
  M1: '1M',
  M3: '3M',
  M6: '6M',
  Y: 'Y',
};

export interface ScheduleAdjustFormProps {
  assetId: string;
  /**
   * ALWAYS sent. Since slice 27 a rule hangs off a DOCUMENT, so a machine can
   * carry two rules at the same frequency from different documents; the
   * server refuses an ambiguous adjustment rather than guessing, and there is
   * no case where omitting it is safer than naming the row on screen.
   */
  assetDocumentId: string;
  frequency: Frequency;
  /** Seeds the date field — the rule's current next-due date. */
  currentNextDueOn: string;
  /** Names the thing being adjusted, for the form's accessible name. */
  label: string;
  onCancel: () => void;
  /** Called after a successful save so the caller can reload its own data. */
  onSaved: (message: string) => void | Promise<void>;
}

/**
 * THE ONE next-due-date editor, slice 31-PLANNER.
 *
 * Extracted from `MachineSchedule` when `/planner` needed the same edit:
 * `MachineSchedule` (one machine, a list) and `Planner` (every machine, a
 * grid) are two ways of LOOKING at `schedule_rule`, and they must not become
 * two ways of WRITING to it. Two copies would drift — the likeliest drift
 * being the mandatory reason, whose whole purpose is that the audit trail can
 * never contain an unexplained schedule change (PR-058/UR-025). One of the
 * two copies would eventually accept nine characters, or stop trimming, and
 * the server would return a 422 whose entire detail is "Request body failed
 * validation." naming no field.
 *
 * So both screens mount THIS, which owns the whole interaction: the two
 * fields, the client-side floors that keep the unnameable 422 unreachable,
 * the single `adjustAssetSchedule` call, and the refusal text.
 *
 * IT DOES NOT DECIDE WHO MAY EDIT. Callers render it only for a caller
 * `rolesCanAdjustSchedule` admits — presentation only (non-negotiable #6);
 * the server's `@Roles()` on `PUT /assets/{assetId}/schedule` is the
 * authority, and its refusal is surfaced here verbatim if it comes.
 */
export function ScheduleAdjustForm({
  assetId,
  assetDocumentId,
  frequency,
  currentNextDueOn,
  label,
  onCancel,
  onSaved,
}: ScheduleAdjustFormProps) {
  const [draftDate, setDraftDate] = useState(currentNextDueOn);
  const [draftReason, setDraftReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonTooShort = draftReason.trim().length < MIN_REASON;
  // Slice 29 review IMPORTANT-1: `<input type="date">` is clearable — a
  // planner retyping the date on a tablet picker can send `nextDueOn: ''`,
  // which fails `z.string().min(1)` (shared/src/schedule.ts) as a 422 whose
  // whole detail is "Request body failed validation.", naming no field.
  const dateMissing = draftDate === '';

  const fieldId = `schedule-adjust-${assetDocumentId}-${frequency}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await adjustAssetSchedule(assetId, {
        assetDocumentId,
        frequency,
        nextDueOn: draftDate,
        adjustedReason: draftReason.trim(),
      });
      if (result.ok) {
        await onSaved(`Next due date saved for ${label}.`);
      } else {
        setError(refusalText(result.status, result.problem));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label={`Adjust schedule for ${label}`}>
      <div className="field">
        <label htmlFor={`${fieldId}-date`}>Next due date</label>
        <input
          id={`${fieldId}-date`}
          type="date"
          value={draftDate}
          onChange={(e) => setDraftDate(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${fieldId}-reason`}>Reason for this change</label>
        <textarea
          id={`${fieldId}-reason`}
          rows={3}
          value={draftReason}
          onChange={(e) => setDraftReason(e.target.value)}
          aria-describedby={`${fieldId}-hint`}
        />
        <p className="field-hint" id={`${fieldId}-hint`}>
          Required, at least {MIN_REASON} characters. Recorded permanently in the audit trail.
        </p>
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
          disabled={busy || reasonTooShort || dateMissing}
        >
          Save
        </button>
      </div>
    </form>
  );
}

/** Shared with the screens: `status: 0` is no response at all, never a refusal. */
export function refusalText(status: number, problem?: Problem, what = 'This change'): string {
  if (status === 0) return `Could not reach the server. ${what} needs a connection.`;
  return problem?.detail ?? problem?.title ?? `The server refused this request (${status}).`;
}
