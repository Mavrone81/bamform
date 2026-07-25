import { useCallback, useEffect, useRef, useState } from 'react';
import { getServices } from '../state/services';
import { useRouter } from '../router';
import { stepUp } from '../auth';
import { SignaturePad } from '../components/SignaturePad';
import type { components } from '../api/generated/openapi-types';

type Job = components['schemas']['Job'];
type ApprovalStep = components['schemas']['ApprovalStep'];

const STAGE_LABELS: Record<number, string> = {
  1: 'Verified By (Workshop Team Leader)',
  2: 'Verified By (Engineer)',
};

function isStepUpRequired(problem: { type?: string } | undefined): boolean {
  return Boolean(problem?.type?.includes('step-up-required'));
}

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

  if (job === null) return <main className="app-shell">Loading…</main>;
  if (job === undefined) {
    return (
      <main className="app-shell">
        <p role="alert">{loadError ?? 'This record could not be found.'}</p>
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
  const stage = job.approvalSteps?.length
    ? Math.max(...job.approvalSteps.map((s) => s.stageOrdinal)) + 1
    : 1;
  const canAct = job.status === 'SUBMITTED';

  return (
    <main className="app-shell" aria-labelledby="review-heading">
      <div className="card-row">
        <h1 id="review-heading">{job.jobNumber}</h1>
        <span className="status-chip" data-tone="neutral">
          {job.status}
        </span>
      </div>
      <p>
        {job.assetCode} · {revision?.documentNumber} rev {revision?.revisionCode}
      </p>
      <button type="button" onClick={() => navigate('/queue')} style={{ width: 'fit-content' }}>
        Back to queue
      </button>

      {canAct && (
        <p aria-label="Approval progress">
          Stage {Math.min(stage, 2)} of 2 — needs{' '}
          <strong>{STAGE_LABELS[Math.min(stage, 2)]}</strong>
        </p>
      )}

      {onBehalfOf && (
        <p className="status-chip" data-tone="neutral" style={{ width: 'fit-content' }}>
          <span aria-hidden="true">◈</span> Acting on behalf of the delegator
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

      <section aria-label="Checklist items (read-only)">
        {items.map((item) => {
          const result = itemResultsByItem.get(item.id);
          return (
            <div className="checklist-item" key={item.id}>
              <p>
                <strong>{item.itemNo}.</strong> {item.instruction}
              </p>
              <p className="readonly-value">{result?.status ?? 'No result recorded'}</p>
              {result?.remark && <p>{result.remark}</p>}
            </div>
          );
        })}
      </section>

      {measurements.length > 0 && (
        <section aria-label="Measurements (read-only)">
          {measurements.map((m) => {
            const result = m.id ? measurementResultsByMeasurement.get(m.id) : undefined;
            return (
              <div className="field" key={m.id} style={{ marginBottom: 'var(--space-4)' }}>
                <span>
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
        <section aria-label="Parts used (read-only)">
          <h2>Parts used</h2>
          {job.partsUsed?.map((p) => (
            <p key={p.id}>
              {p.description} · qty {p.quantity}
            </p>
          ))}
        </section>
      )}

      {(job.approvalSteps?.length ?? 0) > 0 && (
        <section aria-label="Approval history">
          <h2>Approval history</h2>
          {job.approvalSteps?.map((step: ApprovalStep) => (
            <div className="approval-step" key={step.id}>
              <p>
                <strong>{step.action}</strong> —{' '}
                {STAGE_LABELS[step.stageOrdinal] ?? `Stage ${step.stageOrdinal}`}
              </p>
              <p>{new Date(step.actedAt).toLocaleString()}</p>
              {step.onBehalfOfName && <p>On behalf of {step.onBehalfOfName}</p>}
              {step.reason && <p>{step.reason}</p>}
            </div>
          ))}
        </section>
      )}

      {canAct && mode === 'view' && (
        <div className="card-row">
          <button type="button" onClick={() => setMode('return')} disabled={submitting}>
            Return
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setMode('sign')}
            disabled={submitting}
          >
            Verify
          </button>
        </div>
      )}

      {canAct && mode === 'sign' && !awaitingStepUp && (
        <section aria-label="Sign to verify">
          <h2>Sign to verify</h2>
          <SignaturePad
            onDone={(dataUrl) => void attemptVerify(dataUrl)}
            onCancel={() => setMode('view')}
            disabled={submitting}
          />
        </section>
      )}

      {awaitingStepUp && (
        <section aria-label="Re-enter your password" role="dialog" aria-modal="true">
          <h2>Re-enter your password to sign</h2>
          <p>For security, verifying a record requires re-confirming your password.</p>
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
          <div className="card-row" style={{ marginTop: 'var(--space-3)' }}>
            <button
              type="button"
              onClick={() => {
                setAwaitingStepUp(false);
                pendingSignatureRef.current = null;
                setMode('view');
              }}
              disabled={stepUpPending}
            >
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
        </section>
      )}

      {canAct && mode === 'return' && (
        <section aria-label="Return for rework">
          <h2>Return for rework</h2>
          <div className="field">
            <label htmlFor="return-reason">Reason (minimum 10 characters)</label>
            <textarea
              id="return-reason"
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              minLength={10}
              rows={3}
              style={{
                width: '100%',
                padding: 'var(--space-2) var(--space-3)',
                border: 'var(--border-width) solid var(--color-border)',
                borderRadius: 'var(--radius)',
                background: 'var(--color-surface-raised)',
              }}
            />
          </div>
          <div className="card-row" style={{ marginTop: 'var(--space-3)' }}>
            <button type="button" onClick={() => setMode('view')} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
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
