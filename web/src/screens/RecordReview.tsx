import { useCallback, useEffect, useRef, useState } from 'react';
import { getServices } from '../state/services';
import { useRouter } from '../router';
import { stepUp } from '../auth';
import { useCriticalWork } from '../lib/use-critical-work';
import { SignaturePad } from '../components/SignaturePad';
import { StatusBadge } from '../components/StatusBadge';
import type { components } from '../api/generated/openapi-types';

type Job = components['schemas']['Job'];
type ApprovalStep = components['schemas']['ApprovalStep'];

const STAGE_LABELS: Record<number, string> = {
  // Slice 18-WORKFLOW §1 — stage 0 is the PERFORMER's own signature, not a
  // verification stage. Without this entry the approval history rendered a
  // bare "Stage 0", which means nothing to anyone in the plant; this is the
  // paper form's own wording.
  0: 'Maintenance Performed By',
  1: 'Verified By (Workshop Team Leader)',
  2: 'Verified By (Engineer)',
};

function isStepUpRequired(problem: { type?: string } | undefined): boolean {
  return Boolean(problem?.type?.includes('step-up-required'));
}

/**
 * Which verification stage this record is awaiting.
 *
 * Counts VERIFIED steps only, and only those in the CURRENT submission cycle
 * — a `RETURNED`/`RECALLED` step supersedes every earlier verification (the
 * content they signed is about to change), exactly the cycle rule the server
 * applies in `verification.service.ts` (SYS-8) and its
 * `approval_step_distinct_stage_verifiers_trg` backstop.
 *
 * The previous derivation was `max(stageOrdinal) + 1` over ALL steps, which
 * read a stage-1 RETURNED step as "stage 1 is complete" and announced
 * "Stage 2 — needs Engineer" to a reworked record that still needed the team
 * leader. Slice 18-WORKFLOW's stage-0 performer signature would have been
 * harmless to that formula, but the formula was already wrong; it is fixed
 * here rather than built on.
 */
export function currentVerificationStage(steps: ApprovalStep[] | undefined): number {
  const list = steps ?? [];
  let lastBreak = -1;
  list.forEach((step, index) => {
    if (step.action === 'RETURNED' || step.action === 'RECALLED') lastBreak = index;
  });
  return list.slice(lastBreak + 1).filter((s) => s.action === 'VERIFIED').length + 1;
}

const ITEM_RESULT_META: Record<string, { icon: string; tone: 'good' | 'bad' | 'neutral' }> = {
  DONE: { icon: '✓', tone: 'good' },
  NOT_DONE: { icon: '✕', tone: 'bad' },
  NOT_APPLICABLE: { icon: '—', tone: 'neutral' },
};

/**
 * Slice 7/11a/11b: the verifier's read-only view of a submitted record —
 * its frozen-revision checklist, measurements, results, parts, attachments
 * and approval history — plus the two actions available from `SUBMITTED`:
 * Verify (opens the signature pad; requires step-up) and Return (reason
 * required, >= 10 characters). Mirrors RecordCapture's layout/markup so the
 * two screens read as the same app, just one editable and one not.
 */
export function RecordReview({ jobId }: { jobId: string }) {
  const { navigate } = useRouter();
  // PR-076: when this record was reached from a delegated queue entry
  // (VerifierQueue passes it through as a query param — the hand-rolled
  // router only tracks `pathname`, not `search`), every signing action on
  // this screen acts on behalf of that delegator rather than the caller's
  // own authority. Read once at mount: this screen is never navigated to
  // itself with a different `onBehalfOf` without a full re-mount (the
  // jobId path param changes too).
  const [onBehalfOf] = useState(() =>
    new URLSearchParams(window.location.search).get('onBehalfOf'),
  );
  const [job, setJob] = useState<Job | null | undefined>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'sign' | 'return'>('view');
  const [returnReason, setReturnReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState('');
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [stepUpPending, setStepUpPending] = useState(false);
  const [awaitingStepUp, setAwaitingStepUp] = useState(false);
  const pendingSignatureRef = useRef<string | null>(null);
  const stepUpDialogRef = useRef<HTMLDialogElement | null>(null);

  /**
   * Slice 22-SELFUPDATE: the verifier's equivalent of the capture screen's
   * gate. The signature pad, a verify/return in flight, the step-up password
   * dialog and a typed return reason are all in-memory only — a reload
   * during any of them makes the verifier do it again, and a reload during
   * the step-up dialog would discard a password mid-entry.
   */
  useCriticalWork(
    mode !== 'view' || submitting || awaitingStepUp || returnReason.length > 0,
    'record-review',
  );

  // The step-up panel is a NATIVE modal dialog (review D-3): `showModal()`
  // puts it in the top layer, traps focus inside and makes everything
  // behind it — the nav shell included — genuinely inert, so the modality
  // assistive tech is told about is the modality keyboard users get. Esc
  // fires `cancel`, routed to the same handler as the Cancel button.
  useEffect(() => {
    const dialog = stepUpDialogRef.current;
    if (awaitingStepUp && dialog && !dialog.open) dialog.showModal();
  }, [awaitingStepUp]);

  function cancelStepUp() {
    setAwaitingStepUp(false);
    pendingSignatureRef.current = null;
    setMode('view');
  }

  const load = useCallback(async () => {
    try {
      const { transport } = getServices();
      const result = await transport.getJob(jobId);
      setJob(result);
      setLoadError(null);
    } catch {
      setJob(undefined);
      setLoadError('Could not load this record.');
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function attemptVerify(drawnSignature: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      const { transport } = getServices();
      const result = await transport.verifyJob(jobId, {
        drawnSignature,
        ...(onBehalfOf ? { onBehalfOf } : {}),
      });
      if (result.ok) {
        setMode('view');
        pendingSignatureRef.current = null;
        setActionBanner(
          result.body?.status === 'ARCHIVED'
            ? 'Verified and archived — approval complete.'
            : 'Verified. Awaiting the next approval stage.',
        );
        void load();
        return;
      }
      if (result.status === 403 && isStepUpRequired(result.problem)) {
        pendingSignatureRef.current = drawnSignature;
        setAwaitingStepUp(true);
        setStepUpError(null);
        return;
      }
      setActionError(result.problem?.title ?? 'The server rejected this verification.');
      setMode('view');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStepUpSubmit() {
    setStepUpPending(true);
    setStepUpError(null);
    try {
      await stepUp(stepUpPassword);
    } catch {
      setStepUpError('Incorrect password. Try again.');
      setStepUpPending(false);
      return;
    }
    setStepUpPassword('');
    setAwaitingStepUp(false);
    setStepUpPending(false);
    const signature = pendingSignatureRef.current;
    if (signature) await attemptVerify(signature);
  }

  async function handleReturn() {
    setSubmitting(true);
    setActionError(null);
    try {
      const { transport } = getServices();
      const result = await transport.returnJob(jobId, returnReason);
      if (result.ok) {
        setMode('view');
        setReturnReason('');
        setActionBanner('Returned to the technician for rework.');
        void load();
        return;
      }
      setActionError(result.problem?.title ?? 'The server rejected this return.');
    } finally {
      setSubmitting(false);
    }
  }

  if (job === null) {
    return (
      <main className="app-shell">
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      </main>
    );
  }
  if (job === undefined) {
    return (
      <main className="app-shell">
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {loadError ?? 'This record could not be found.'}
        </p>
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/queue')}>
          <span aria-hidden="true">‹</span> Back to queue
        </button>
      </main>
    );
  }

  const revision = job.templateRevision;
  const items = revision?.items ?? [];
  const measurements = revision?.measurements ?? [];
  const itemResultsByItem = new Map((job.itemResults ?? []).map((r) => [r.templateItemId, r]));
  const measurementResultsByMeasurement = new Map(
    (job.measurementResults ?? []).map((r) => [r.templateMeasurementId, r]),
  );
  /**
   * Which verification stage this record is awaiting. Derived from the
   * VERIFIED steps only — a `SUBMITTED` (stage-0 performer signature, slice
   * 18-WORKFLOW) or `RETURNED` step is not a completed verification stage
   * and must not advance the counter. The previous `max(stageOrdinal) + 1`
   * over ALL steps read a stage-1 RETURNED step as "stage 1 is done" and
   * announced stage 2 to a reworked record that still needs stage 1 — a
   * pre-existing defect this slice's stage-0 step would have compounded.
   */
  const stage = currentVerificationStage(job.approvalSteps);
  const canAct = job.status === 'SUBMITTED';

  return (
    <main className="app-shell" aria-labelledby="review-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/queue')}>
          <span aria-hidden="true">‹</span> Back to queue
        </button>
        <div className="card-row">
          <h1 id="review-heading" className="job-code" style={{ marginBottom: 0 }}>
            {job.jobNumber}
          </h1>
          <StatusBadge status={job.status ?? 'SCHEDULED'} />
        </div>
        <p className="screen-meta">
          {job.assetCode} · {revision?.documentNumber} rev {revision?.revisionCode}
        </p>
      </header>

      {canAct && (
        <p className="banner" data-tone="info" aria-label="Approval progress">
          <span aria-hidden="true">◐</span>
          <span>
            Stage {Math.min(stage, 2)} of 2 — needs{' '}
            <strong>{STAGE_LABELS[Math.min(stage, 2)]}</strong>
          </span>
        </p>
      )}

      {onBehalfOf && (
        <p className="status-chip" data-tone="info" style={{ alignSelf: 'flex-start' }}>
          <span aria-hidden="true">◈</span>
          <span>Acting on behalf of the delegator</span>
        </p>
      )}

      {actionBanner && (
        <p className="banner" data-tone="good" role="status">
          <span aria-hidden="true">✓</span> {actionBanner}
        </p>
      )}
      {actionError && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {actionError}
        </p>
      )}

      <section aria-label="Checklist items (read-only)" className="review-section">
        <h2 className="microlabel">Checklist</h2>
        {items.map((item) => {
          const result = itemResultsByItem.get(item.id);
          const meta = result?.status ? ITEM_RESULT_META[result.status] : undefined;
          return (
            <div className="review-item" key={item.id}>
              <p className="checklist-instruction">
                <span className="item-no">{item.itemNo}</span>
                <span>{item.instruction}</span>
              </p>
              <span className="status-chip" data-tone={meta?.tone ?? 'attention'}>
                <span aria-hidden="true">{meta?.icon ?? '⚠'}</span>
                <span>{result?.status ?? 'No result recorded'}</span>
              </span>
              {result?.remark && <p className="review-remark">{result.remark}</p>}
            </div>
          );
        })}
      </section>

      {measurements.length > 0 && (
        <section aria-label="Measurements (read-only)" className="review-section">
          <h2 className="microlabel">Measurements</h2>
          {measurements.map((m) => {
            const result = m.id ? measurementResultsByMeasurement.get(m.id) : undefined;
            return (
              <div className="kv-row" key={m.id}>
                <span className="kv-label">
                  {m.description} <span className="numeric">({m.specDisplay})</span>
                </span>
                <span className="readonly-value numeric">
                  {result?.readingNumeric ?? result?.readingText ?? '—'}
                  {result?.judgement ? ` (${result.judgement})` : ''}
                </span>
              </div>
            );
          })}
        </section>
      )}

      {(job.partsUsed?.length ?? 0) > 0 && (
        <section aria-label="Parts used (read-only)" className="review-section">
          <h2 className="microlabel">Parts used</h2>
          {job.partsUsed?.map((p) => (
            <div className="kv-row" key={p.id}>
              <span className="kv-label">{p.description}</span>
              <span className="readonly-value numeric">qty {p.quantity}</span>
            </div>
          ))}
        </section>
      )}

      {(job.approvalSteps?.length ?? 0) > 0 && (
        <section aria-label="Approval history" className="review-section">
          <h2 className="microlabel">Approval history</h2>
          {job.approvalSteps?.map((step: ApprovalStep) => (
            <div className="approval-step" key={step.id}>
              <p>
                <strong>{step.action}</strong> —{' '}
                {STAGE_LABELS[step.stageOrdinal] ?? `Stage ${step.stageOrdinal}`}
              </p>
              <p className="approval-step-when">{new Date(step.actedAt).toLocaleString()}</p>
              {step.onBehalfOfName && (
                <p className="text-soft">On behalf of {step.onBehalfOfName}</p>
              )}
              {step.reason && <p>{step.reason}</p>}
            </div>
          ))}
        </section>
      )}

      {canAct && mode === 'view' && (
        <div className="action-bar">
          <button
            type="button"
            className="btn-primary btn-block btn-capture"
            onClick={() => setMode('sign')}
            disabled={submitting}
          >
            Verify
          </button>
          <button
            type="button"
            className="btn-block"
            onClick={() => setMode('return')}
            disabled={submitting}
          >
            Return
          </button>
        </div>
      )}

      {canAct && mode === 'sign' && !awaitingStepUp && (
        <section aria-label="Sign to verify" className="dialog">
          <h2>Sign to verify</h2>
          <p style={{ margin: 0 }} className="text-soft">
            Your drawn signature is recorded on the verified record.
          </p>
          <SignaturePad
            onDone={(dataUrl) => void attemptVerify(dataUrl)}
            onCancel={() => setMode('view')}
            disabled={submitting}
          />
        </section>
      )}

      {awaitingStepUp && (
        <dialog
          ref={stepUpDialogRef}
          className="dialog"
          aria-labelledby="step-up-heading"
          onCancel={(e) => {
            // Esc while the confirmation request is in flight must not
            // abandon it half-acknowledged — same rule as the disabled
            // Cancel button.
            if (stepUpPending) {
              e.preventDefault();
              return;
            }
            cancelStepUp();
          }}
        >
          <h2 id="step-up-heading">Re-enter your password to sign</h2>
          <p style={{ margin: 0 }} className="text-soft">
            For security, verifying a record requires re-confirming your password.
          </p>
          <div className="field">
            <label htmlFor="step-up-password">Password</label>
            <input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              value={stepUpPassword}
              onChange={(e) => setStepUpPassword(e.target.value)}
            />
          </div>
          {stepUpError && (
            <p className="field-error" role="alert">
              {stepUpError}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={cancelStepUp} disabled={stepUpPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleStepUpSubmit()}
              disabled={stepUpPending || stepUpPassword.length === 0}
            >
              {stepUpPending ? 'Confirming…' : 'Confirm'}
            </button>
          </div>
        </dialog>
      )}

      {canAct && mode === 'return' && (
        <section aria-label="Return for rework" className="dialog">
          <h2>Return for rework</h2>
          <p style={{ margin: 0 }} className="text-soft">
            The record goes back to the technician with your reason attached.
          </p>
          <div className="field">
            <label htmlFor="return-reason">Reason (minimum 10 characters)</label>
            <textarea
              id="return-reason"
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              minLength={10}
              rows={3}
            />
          </div>
          <div className="dialog-actions">
            <button type="button" onClick={() => setMode('view')} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-destructive"
              onClick={() => void handleReturn()}
              disabled={submitting || returnReason.trim().length < 10}
            >
              Return
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
