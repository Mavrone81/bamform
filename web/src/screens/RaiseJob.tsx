import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '../router';
import { listAssets, listAssetTypes, type Asset, type AssetType } from '../api/admin-client';
import { getServices } from '../state/services';
import { bootstrap } from '../offline/sync-engine';
import { notifySynced } from '../offline/sync-events';
import type { components } from '../api/generated/openapi-types';

type Frequency = components['schemas']['Frequency'];

const FREQUENCY_LABELS: Array<{ value: Frequency; label: string }> = [
  { value: 'M1', label: 'Monthly (1M)' },
  { value: 'M3', label: 'Quarterly (3M)' },
  { value: 'M6', label: 'Half-yearly (6M)' },
  { value: 'Y', label: 'Yearly' },
];

const MIN_REASON = 10;

/**
 * Slice 18-WORKFLOW §2 — "Raise a job". The owner's process, step 1: the team
 * works from "the maintenance plan OR AD-HOC REQUEST", and until this screen
 * there was no way to record the second kind at all.
 *
 * ONLINE-ONLY, deliberately and visibly. Raising a job needs the server's
 * machine list, its current frozen template revision and a job number, none
 * of which a device can invent offline — so the screen says so rather than
 * queueing something it cannot honour. This is the same stance the photo
 * section of RecordCapture takes, and it does not touch the offline
 * guarantee that matters (RK-01 is about not losing a technician's COMPLETED
 * record; nothing is at risk here).
 *
 * Presentation-only role gating (non-negotiable #6): the Menu entry appears
 * for the roles the server permits, but the URL stays reachable and the
 * server's own 403 is what refuses anyone else — surfaced here verbatim.
 */
export function RaiseJob() {
  const { navigate } = useRouter();
  const [assetTypes, setAssetTypes] = useState<AssetType[] | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [assetId, setAssetId] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('M1');
  const [reason, setReason] = useState('');
  const [dueOn, setDueOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    void listAssetTypes().then((result) => setAssetTypes(result.ok ? result.value.data : []));
  }, []);

  const loadAssets = useCallback(async (assetTypeId: string) => {
    const result = await listAssets(assetTypeId ? { assetTypeId } : {});
    setAssets(result.ok ? result.value.data : []);
    if (!result.ok) {
      setError(
        result.status === 0
          ? 'Could not reach the server. Raising a job needs a connection.'
          : (result.problem?.detail ??
              result.problem?.title ??
              `The server refused the machine list (${result.status}).`),
      );
    }
  }, []);

  useEffect(() => {
    setAssets(null);
    setAssetId('');
    void loadAssets(typeFilter);
  }, [typeFilter, loadAssets]);

  const reasonTooShort = reason.trim().length < MIN_REASON;
  const canRaise = Boolean(assetId) && !reasonTooShort && !submitting && isOnline;

  async function raise() {
    setSubmitting(true);
    setError(null);
    try {
      const { transport } = getServices();
      const result = await transport.createAdhocJob({
        assetId,
        frequency,
        reason: reason.trim(),
        ...(dueOn ? { dueOn } : {}),
      });
      if (result.ok && result.body?.id) {
        // The capture screen reads from the offline cache (a technician's
        // device must be able to open a job with no connection), and a job
        // raised seconds ago is not in it yet. Pull it down BEFORE
        // navigating, so the planner lands on the real record instead of
        // "this job is not cached on this device" — the exact seam an
        // online-only creation flow forgets. A failed sync is not fatal:
        // the job exists on the server either way, so fall back to the job
        // list, which bootstraps on mount.
        try {
          await bootstrap(getServices().db, transport);
          notifySynced();
          navigate(`/jobs/${result.body.id}`);
        } catch {
          navigate('/jobs');
        }
        return;
      }
      setError(
        result.problem?.detail ??
          result.problem?.title ??
          `The server refused this request (${result.status}).`,
      );
    } catch {
      setError(
        'Could not reach the server — nothing was raised. Try again when the connection returns.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell" aria-labelledby="raise-job-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/jobs')}>
          <span aria-hidden="true">‹</span> Back to your jobs
        </button>
        <h1 id="raise-job-heading">Raise a job</h1>
        <p className="screen-meta">
          Work outside the maintenance plan — a breakdown, a call-out, an unplanned service. It does
          not change the plan: the scheduled PM for this machine still falls due when it always did.
        </p>
      </header>

      {!isOnline && (
        <p className="banner" data-tone="info" role="status">
          <span aria-hidden="true">◌</span> Raising a job needs a connection — the machine list and
          its current form come from the server. Your recorded work on other jobs is unaffected and
          safely held on this device.
        </p>
      )}
      {error && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      <div className="field">
        <label htmlFor="raise-type">Machine type</label>
        <select
          id="raise-type"
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

      <div className="field">
        <label htmlFor="raise-asset">Machine</label>
        <select
          id="raise-asset"
          value={assetId}
          onChange={(e) => setAssetId(e.target.value)}
          disabled={assets === null}
        >
          <option value="">{assets === null ? 'Loading…' : 'Choose a machine'}</option>
          {(assets ?? []).map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.code}
              {asset.description ? ` — ${asset.description}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="raise-frequency">Which checklist</label>
        <select
          id="raise-frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as Frequency)}
        >
          {FREQUENCY_LABELS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <p className="field-hint">
          Which depth of the machine&rsquo;s form is being carried out. This labels the record only
          — it does not count towards the plan.
        </p>
      </div>

      <div className="field">
        <label htmlFor="raise-due">Due date</label>
        <input
          id="raise-due"
          type="date"
          value={dueOn}
          onChange={(e) => setDueOn(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="raise-reason">Why is this being raised off-plan?</label>
        <textarea
          id="raise-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby="raise-reason-hint"
        />
        <p className="field-hint" id="raise-reason-hint">
          Required, at least {MIN_REASON} characters. It is recorded permanently in the audit trail
          against this job.
        </p>
      </div>

      <div className="action-bar">
        <button
          type="button"
          className="btn-primary btn-block btn-capture"
          disabled={!canRaise}
          onClick={() => void raise()}
        >
          {submitting ? 'Raising…' : 'Raise this job'}
        </button>
      </div>
    </main>
  );
}
