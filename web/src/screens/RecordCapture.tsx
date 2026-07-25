import { useEffect, useState, useCallback, useRef } from 'react';
import { getServices } from '../state/services';
import {
  getCachedJob,
  jobSyncState,
  submitJob,
  triggerDrainIfOnline,
  appendJobMutation,
  type JobSyncState,
} from '../offline/sync-engine';
import { pendingCountForJob } from '../offline/outbox';
import { onSynced, notifySynced } from '../offline/sync-events';
import type { CachedJob } from '../offline/db';
import { ItemStatusControl } from '../components/ItemStatusControl';
import { SyncStatusChip } from '../components/SyncStatusChip';
import { useRouter } from '../router';
import type { components } from '../api/generated/openapi-types';

type ItemStatus = components['schemas']['ItemStatus'];

export function RecordCapture({ jobId }: { jobId: string }) {
  const { navigate } = useRouter();
  const [cached, setCached] = useState<CachedJob | undefined | null>(null);
  const [itemResults, setItemResults] = useState<Record<string, ItemStatus>>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [syncState, setSyncState] = useState<JobSyncState>('held-on-device');
  const [pendingCount, setPendingCount] = useState(0);
  const [quotaBanner, setQuotaBanner] = useState(false);
  const [submitBanner, setSubmitBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refreshState = useCallback(async () => {
    const { db } = getServices();
    setSyncState(await jobSyncState(db, jobId));
    setPendingCount(await pendingCountForJob(db, jobId));
  }, [jobId]);

  useEffect(() => {
    const { db } = getServices();
    getCachedJob(db, jobId).then((job) => {
      setCached(job ?? undefined);
      if (job) {
        const results: Record<string, ItemStatus> = {};
        for (const r of job.job.itemResults ?? []) results[r.templateItemId] = r.status;
        setItemResults(results);
        const readingValues: Record<string, string> = {};
        for (const m of job.job.measurementResults ?? []) {
          if (m.readingNumeric != null)
            readingValues[m.templateMeasurementId] = String(m.readingNumeric);
        }
        setReadings(readingValues);
      }
    });
    void refreshState();
    // Reflects a drain that completes while this screen is open, even
    // though the drain itself is triggered app-wide in App.tsx, not here.
    return onSynced(() => void refreshState());
  }, [jobId, refreshState]);

  async function recordItemStatus(templateItemId: string, status: ItemStatus) {
    const { db, transport } = getServices();
    const result = await appendJobMutation(db, {
      jobId,
      method: 'PUT',
      path: `/jobs/${jobId}/items/${templateItemId}`,
      body: { status, clientRecordedAt: new Date().toISOString() },
      clientRecordedAt: new Date().toISOString(),
    });
    if (!result.ok) {
      // O-11: device storage is full. Do NOT show this as recorded — that
      // would be exactly the silent loss the offline suite forbids.
      setQuotaBanner(true);
      return;
    }
    setQuotaBanner(false);
    setItemResults((prev) => ({ ...prev, [templateItemId]: status }));
    void refreshState();
    // The entry is already durable in IndexedDB regardless of what happens
    // next (append() already returned ok:true) — this is purely "send it
    // now if we can", not part of the durability guarantee.
    triggerDrainIfOnline(db, transport, () => notifySynced());
  }

  function recordMeasurement(templateMeasurementId: string, rawValue: string) {
    setReadings((prev) => ({ ...prev, [templateMeasurementId]: rawValue }));
    clearTimeout(debounceRef.current[templateMeasurementId]);
    debounceRef.current[templateMeasurementId] = setTimeout(async () => {
      const { db, transport } = getServices();
      const numeric = rawValue.trim() === '' ? null : Number(rawValue);
      const result = await appendJobMutation(db, {
        jobId,
        method: 'PUT',
        path: `/jobs/${jobId}/measurements/${templateMeasurementId}`,
        body: { readingNumeric: numeric, clientRecordedAt: new Date().toISOString() },
        clientRecordedAt: new Date().toISOString(),
      });
      if (!result.ok) {
        setQuotaBanner(true);
        return;
      }
      setQuotaBanner(false);
      void refreshState();
      triggerDrainIfOnline(db, transport, () => notifySynced());
    }, 400);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitBanner(null);
    try {
      const { db, transport } = getServices();
      const result = await submitJob(db, transport, jobId);
      if (result.ok) {
        navigate('/jobs');
        return;
      }
      if (result.reason === 'pending-mutations') {
        setSubmitBanner('Still sending earlier entries — try again once they finish.');
      } else if (result.reason === 'server-removed') {
        setSubmitBanner(
          'This job was reassigned on the server. It cannot be submitted from this device.',
        );
      } else {
        setSubmitBanner(
          'The server rejected this submission. Check that every mandatory item has a result.',
        );
      }
    } finally {
      setSubmitting(false);
      void refreshState();
    }
  }

  if (cached === null) return <main className="app-shell">Loading…</main>;
  if (cached === undefined) {
    return (
      <main className="app-shell">
        <p role="alert">
          This job is not cached on this device. Reconnect and sync from the job list first.
        </p>
      </main>
    );
  }

  const revision = cached.job.templateRevision;
  const items = revision?.items ?? [];
  // `TemplateMeasurement.id` is server-assigned and typed optional in the
  // contract (never sent by the client, per TemplateItemInput's analogous
  // rule) — a measurement on an already-issued, frozen revision always has
  // one in practice; this filter just satisfies that at the type level
  // rather than asserting it with a cast.
  const measurements = (revision?.measurements ?? []).filter(
    (m): m is typeof m & { id: string } => typeof m.id === 'string',
  );
  const canSubmit = pendingCount === 0 && !cached.serverRemoved && syncState !== 'conflict';

  return (
    <main className="app-shell" aria-labelledby="record-heading">
      <div className="card-row">
        <h1 id="record-heading">{cached.job.jobNumber}</h1>
        <SyncStatusChip state={syncState} />
      </div>
      <p>
        {cached.job.assetCode} · {revision?.documentNumber} rev {revision?.revisionCode}
      </p>

      {quotaBanner && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> Device storage is full. This entry was NOT saved — free
          up space (Settings → Storage) and try again before continuing.
        </p>
      )}
      {cached.serverRemoved && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> This job was reassigned or removed on the server. Your
          local entries are kept, but this record cannot be submitted from this device.
        </p>
      )}
      {submitBanner && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {submitBanner}
        </p>
      )}

      <section aria-label="Checklist items">
        {items.map((item) => (
          <div className="checklist-item" key={item.id}>
            <p>
              <strong>{item.itemNo}.</strong> {item.instruction}
            </p>
            <ItemStatusControl
              itemNo={item.itemNo}
              instruction={item.instruction}
              value={itemResults[item.id] ?? null}
              onChange={(status) => void recordItemStatus(item.id, status)}
            />
          </div>
        ))}
      </section>

      {measurements.length > 0 && (
        <section aria-label="Measurements">
          {measurements.map((m) => (
            <div className="field" key={m.id} style={{ marginBottom: 'var(--space-4)' }}>
              <label htmlFor={`m-${m.id}`}>
                {m.description} <span className="numeric">({m.specDisplay})</span>
              </label>
              <input
                id={`m-${m.id}`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={readings[m.id] ?? ''}
                onChange={(e) => recordMeasurement(m.id, e.target.value)}
              />
            </div>
          ))}
        </section>
      )}

      <button
        type="button"
        className="btn-primary"
        style={{ width: '100%' }}
        disabled={!canSubmit || submitting}
        onClick={() => void handleSubmit()}
      >
        {submitting
          ? 'Submitting…'
          : pendingCount > 0
            ? `Sending ${pendingCount} entr${pendingCount === 1 ? 'y' : 'ies'}…`
            : 'Submit'}
      </button>
    </main>
  );
}
