import { useEffect, useState, useCallback, useRef } from 'react';
import { getServices, getSyncUserId } from '../state/services';
import {
  getCachedJob,
  jobSyncState,
  submitJob,
  triggerDrainIfOnline,
  appendJobMutation,
  type JobSyncState,
} from '../offline/sync-engine';
import { jobOutboxCounts, type JobOutboxCounts } from '../offline/outbox';
import { recoverJobConflicts, type ConflictRecoveryChoice } from '../offline/conflict-recovery';
import { onSynced, notifySynced } from '../offline/sync-events';
import type { CachedJob } from '../offline/db';
import { uuidv7 } from '../lib/uuidv7';
import { ItemStatusControl } from '../components/ItemStatusControl';
import { SignaturePad } from '../components/SignaturePad';
import { SyncStatusChip } from '../components/SyncStatusChip';
import { useRouter } from '../router';

import type { components } from '../api/generated/openapi-types';

type ItemStatus = components['schemas']['ItemStatus'];
type ApprovalStep = components['schemas']['ApprovalStep'];
type Attachment = components['schemas']['Attachment'];

/**
 * Turn an RFC 7807 problem into something a technician can act on.
 *
 * The owner hit "The server rejected this submission: Validation failed" on a
 * real phone and had no way forward (2026-07-28). The server had in fact said
 * exactly what was wrong — `detail` plus a field-level `errors[]` naming
 * `/drawnSignature` — and this screen was reading only `title`, the one field
 * guaranteed to be generic. An error that names the failing field is worth
 * more than a polite sentence that names nothing.
 *
 * The signature case gets its own message because it has a specific cause
 * that no amount of retrying fixes: the browser is running CACHED JavaScript
 * from before the signature step existed, so it submits without one against a
 * server that now requires it. Telling that user to "check every item has a
 * result" sends them to look at a checklist that is already complete.
 */
export function explainSubmitRejection(problem: unknown): string {
  const p = problem as
    | { title?: string; detail?: string; errors?: { pointer?: string; message?: string }[] }
    | undefined;
  const fields = p?.errors ?? [];

  if (fields.some((e) => (e.pointer ?? '').includes('drawnSignature'))) {
    return (
      'This app is running an out-of-date version and submitted without a signature. ' +
      'Close it completely and reopen to update, then submit again — your entries are ' +
      'safely held on this device.'
    );
  }

  const named = fields
    .map((e) => {
      const field = (e.pointer ?? '').replace(/^\//, '');
      return field ? `${field}: ${e.message ?? 'invalid'}` : e.message;
    })
    .filter(Boolean);
  if (named.length > 0) {
    return `The server rejected this submission — ${named.join('; ')}`;
  }

  if (p?.detail) return `The server rejected this submission: ${p.detail}`;
  if (p?.title) return `The server rejected this submission: ${p.title}`;
  return 'The server rejected this submission. Check that every mandatory item has a result.';
}

/** D-2a: the latest RETURNED step, but only while the job is back in a
 * capturable state — once resubmitted, the capture screen is no longer
 * where this history belongs. */
function activeReturn(job: CachedJob['job']): ApprovalStep | null {
  if (job.status !== 'IN_PROGRESS' && job.status !== 'ASSIGNED') return null;
  const steps = job.approvalSteps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.action === 'RETURNED') return step;
    // A newer submit supersedes any older return.
    if (step.action === 'SUBMITTED') return null;
  }
  return null;
}

interface StagedPhoto {
  key: string;
  file: File;
  previewUrl: string;
  state: 'staged' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
  /** Persisted per photo so a retried upload REPLAYS rather than duplicates. */
  idempotencyKey: string;
  error?: string;
  attachment?: Attachment;
}

export function RecordCapture({ jobId }: { jobId: string }) {
  const { navigate } = useRouter();
  const [cached, setCached] = useState<CachedJob | undefined | null>(null);
  const [itemResults, setItemResults] = useState<Record<string, ItemStatus>>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [syncState, setSyncState] = useState<JobSyncState>('held-on-device');
  const [counts, setCounts] = useState<JobOutboxCounts>({
    total: 0,
    sendable: 0,
    failed: 0,
    conflict: 0,
  });
  const [locallyEdited, setLocallyEdited] = useState<Record<string, boolean>>({});
  /** D-2a: items edited during THIS screen session. `locallyEdited` (from
   * the outbox) empties the moment an edit is acknowledged, but the cached
   * job snapshot only reflects it after the next bootstrap — without this,
   * the "Edited since return" mark would flicker off in that window. */
  const [editedThisSession, setEditedThisSession] = useState<Record<string, boolean>>({});
  const [quotaBanner, setQuotaBanner] = useState(false);
  const [submitBanner, setSubmitBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Slice 18-WORKFLOW §1 — the signature pad is open, awaiting the
   * performer's signature. Submit does not happen until they sign. */
  const [signing, setSigning] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryBanner, setRecoveryBanner] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [photos, setPhotos] = useState<StagedPhoto[]>([]);
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** H-7: staged/uploading photos are screen-local — leaving discards
   * them. The Back button confirms first instead of silently binning the
   * evidence the technician believed was attached. (Tab-bar navigation is
   * outside this screen's reach — see the report's stated limitation.) */
  const leaveConfirmRef = useRef<HTMLDialogElement>(null);

  const loadCached = useCallback(async () => {
    const { db } = getServices();
    const userId = getSyncUserId();
    if (!userId) return;
    const job = await getCachedJob(db, userId, jobId);
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
  }, [jobId]);

  const refreshState = useCallback(async () => {
    const { db } = getServices();
    const userId = getSyncUserId();
    if (!userId) return;
    setSyncState(await jobSyncState(db, userId, jobId));
    setCounts(await jobOutboxCounts(db, userId, jobId));
    // D-2a: which items have local (not-yet-acknowledged) edits — the
    // outbox is the source of truth for "changed on this device".
    const rows = await db.outbox.where('[userId+jobId]').equals([userId, jobId]).toArray();
    const edited: Record<string, boolean> = {};
    for (const row of rows) {
      const match = row.path.match(/\/items\/([^/]+)$/);
      if (match) edited[match[1]] = true;
    }
    setLocallyEdited(edited);
  }, [jobId]);

  useEffect(() => {
    void loadCached();
    void refreshState();
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // Reflects a drain that completes while this screen is open, even
    // though the drain itself is triggered app-wide in App.tsx, not here.
    const unsubscribe = onSynced(() => void refreshState());
    return () => {
      unsubscribe();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadCached, refreshState]);

  // Object URLs leak unless revoked — release them when the screen goes.
  // Ref, not state, in the cleanup: an unmount-only effect would otherwise
  // close over the initial (empty) photos array.
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(
    () => () => {
      for (const photo of photosRef.current) URL.revokeObjectURL(photo.previewUrl);
    },
    [],
  );

  async function recordItemStatus(templateItemId: string, status: ItemStatus) {
    const { db, transport } = getServices();
    const userId = getSyncUserId();
    if (!userId) return;
    const result = await appendJobMutation(db, {
      userId,
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
    setEditedThisSession((prev) => ({ ...prev, [templateItemId]: true }));
    void refreshState();
    // The entry is already durable in IndexedDB regardless of what happens
    // next (append() already returned ok:true) — this is purely "send it
    // now if we can", not part of the durability guarantee.
    triggerDrainIfOnline(db, transport, getSyncUserId, () => notifySynced());
  }

  function recordMeasurement(templateMeasurementId: string, rawValue: string) {
    setReadings((prev) => ({ ...prev, [templateMeasurementId]: rawValue }));
    clearTimeout(debounceRef.current[templateMeasurementId]);
    debounceRef.current[templateMeasurementId] = setTimeout(async () => {
      const { db, transport } = getServices();
      const userId = getSyncUserId();
      if (!userId) return;
      const numeric = rawValue.trim() === '' ? null : Number(rawValue);
      const result = await appendJobMutation(db, {
        userId,
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
      triggerDrainIfOnline(db, transport, getSyncUserId, () => notifySynced());
    }, 400);
  }

  // ---- SYS-5: conflict recovery ----

  async function recoverConflicts(choice: ConflictRecoveryChoice) {
    const { db, transport } = getServices();
    const userId = getSyncUserId();
    if (!userId) return;
    setRecovering(true);
    setRecoveryBanner(null);
    try {
      const result = await recoverJobConflicts(db, transport, userId, jobId, choice);
      if (!result.ok) {
        setRecoveryBanner(
          result.reason === 'job-inaccessible'
            ? // H-3: the server ANSWERED — saying "reconnect" here would be
              // a lie an online technician can never escape.
              'This job is no longer available to you on the server — it may have been reassigned or removed. Sending your entries again cannot succeed. “Discard mine” is the way out; your other jobs are unaffected.'
            : 'Recovery needs a connection — the server’s current version of this job must be fetched first. Reconnect and try again. Nothing was changed or lost.',
        );
        return;
      }
      setRecoveryBanner(
        result.action === 'kept-mine'
          ? 'Your entries were re-queued against the server’s current version and are being resent.'
          : result.jobInaccessible
            ? 'Your unsent entries were discarded. This job is no longer available to you on the server (reassigned or removed), so nothing further can be sent for it from this device.'
            : 'Your conflicting entries were discarded and this job now shows the server’s version.',
      );
      await loadCached();
      notifySynced();
    } finally {
      setRecovering(false);
      void refreshState();
    }
  }

  // ---- D-2b: photo capture (online-only v1) ----

  function stagePhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const staged: StagedPhoto[] = Array.from(files).map((file) => ({
      key: uuidv7(),
      file,
      previewUrl: URL.createObjectURL(file),
      state: 'staged',
      progress: 0,
      idempotencyKey: uuidv7(),
    }));
    setPhotos((prev) => [...prev, ...staged]);
    // Allow re-selecting the same file after a remove.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removePhoto(key: string) {
    setPhotos((prev) => {
      const photo = prev.find((p) => p.key === key);
      if (photo) URL.revokeObjectURL(photo.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  async function uploadPhoto(key: string) {
    const photo = photos.find((p) => p.key === key);
    if (!photo || photo.state === 'uploading' || photo.state === 'uploaded') return;
    const { transport } = getServices();
    const patch = (update: Partial<StagedPhoto>) =>
      setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, ...update } : p)));

    patch({ state: 'uploading', progress: 0, error: undefined });
    try {
      const result = await transport.uploadAttachment(jobId, photo.file, {
        idempotencyKey: photo.idempotencyKey,
        onProgress: (fraction) => patch({ progress: fraction }),
      });
      if (result.ok) {
        patch({ state: 'uploaded', progress: 1, attachment: result.attachment });
      } else {
        const title = (result.problem as { title?: string } | undefined)?.title;
        patch({
          state: 'failed',
          error: title ?? `The server refused this photo (${result.status}).`,
        });
      }
    } catch {
      patch({
        state: 'failed',
        error:
          'Connection lost during upload — the photo is still on this screen. Retry when online.',
      });
    }
  }

  /**
   * Slice 18-WORKFLOW §1 — the PERFORMER signs before the record leaves the
   * device. `drawnSignature` comes from the SAME `SignaturePad` the verifier
   * stages use (stylus, finger and mouse through one pointer-event path,
   * blank-rejected client-side and magic-byte re-validated server-side); the
   * pad is a `<canvas>` and works with no connection.
   */
  async function handleSubmit(drawnSignature: string) {
    setSigning(false);
    setSubmitting(true);
    setSubmitBanner(null);
    try {
      const { db, transport } = getServices();
      const userId = getSyncUserId();
      if (!userId) return;
      const result = await submitJob(db, transport, userId, jobId, drawnSignature);
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
      } else if (result.reason === 'network') {
        // SYS-14: retryable, and the record is safe — say exactly that.
        setSubmitBanner(
          'Could not reach the server — the record is safely held on this device. Try again when the connection returns.',
        );
      } else if (result.status === 409) {
        setSubmitBanner(
          'The server reports this job is no longer in a submittable state — it may already be submitted, returned or voided. Go back to your jobs and sync to see its current state.',
        );
      } else {
        setSubmitBanner(explainSubmitRejection(result.problem));
      }
    } finally {
      setSubmitting(false);
      void refreshState();
    }
  }

  if (cached === null) {
    return (
      <main className="app-shell">
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      </main>
    );
  }
  if (cached === undefined) {
    return (
      <main className="app-shell">
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> This job is not cached on this device for your account.
          Reconnect and sync from the job list first.
        </p>
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/jobs')}>
          <span aria-hidden="true">‹</span> Back to your jobs
        </button>
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
  const returnedStep = activeReturn(cached.job);
  const returnedAtMs = returnedStep ? Date.parse(returnedStep.actedAt) : null;
  const serverAttachments = cached.job.attachments ?? [];
  const uploadsInFlight = photos.some((p) => p.state === 'uploading');
  const photosAwaitingAction = photos.some((p) => p.state === 'staged' || p.state === 'failed');
  const hasConflict = counts.conflict > 0;
  // H-3: `failed` rows (non-409 refusals — e.g. the job was reassigned
  // away) are as much a dead end as conflicts: drains re-send them into
  // the same refusal forever. Both classes get the recovery panel.
  const needsRecovery = counts.conflict + counts.failed > 0;
  const canSubmit =
    counts.total === 0 &&
    !cached.serverRemoved &&
    !needsRecovery &&
    !uploadsInFlight &&
    !photosAwaitingAction;
  const recordedCount = items.filter((item) => itemResults[item.id] != null).length;

  /** D-2a: an item counts as changed-since-return when the SERVER recorded
   * a result for it after the return (recordedAt > actedAt), or this
   * device holds a not-yet-acknowledged edit for it. */
  function editedSinceReturn(templateItemId: string): boolean {
    if (!returnedStep) return false;
    if (locallyEdited[templateItemId] || editedThisSession[templateItemId]) return true;
    if (returnedAtMs == null || Number.isNaN(returnedAtMs)) return false;
    const result = (cached!.job.itemResults ?? []).find((r) => r.templateItemId === templateItemId);
    if (!result?.recordedAt) return false;
    const recordedMs = Date.parse(result.recordedAt);
    return !Number.isNaN(recordedMs) && recordedMs > returnedAtMs;
  }

  const pendingPhotoCount = photos.filter((p) => p.state !== 'uploaded').length;

  function handleBack() {
    if (pendingPhotoCount > 0) {
      leaveConfirmRef.current?.showModal();
      return;
    }
    navigate('/jobs');
  }

  return (
    <main className="app-shell" aria-labelledby="record-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={handleBack}>
          <span aria-hidden="true">‹</span> Back to your jobs
        </button>
        <div className="card-row">
          <h1 id="record-heading" className="job-code" style={{ marginBottom: 0 }}>
            {cached.job.jobNumber}
          </h1>
          <SyncStatusChip state={syncState} />
        </div>
        <p className="screen-meta">
          {cached.job.assetCode} · {revision?.documentNumber} rev {revision?.revisionCode}
        </p>
        {items.length > 0 && (
          <div className="progress-plate">
            <p className="screen-meta" style={{ color: 'var(--color-ink-soft)' }}>
              <span className="numeric">
                {recordedCount} of {items.length}
              </span>{' '}
              checklist items recorded
            </p>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-fill"
                style={{ width: `${(recordedCount / items.length) * 100}%` }}
              />
            </div>
          </div>
        )}
      </header>

      {returnedStep && (
        <section
          className="banner"
          data-tone="attention"
          role="alert"
          aria-label="Returned by verifier"
        >
          <p style={{ marginBottom: 'var(--space-2)' }}>
            <span aria-hidden="true">↩</span> <strong>Returned by {returnedStep.actorName}</strong>
            {returnedStep.actedAt && (
              <>
                {' '}
                <span className="numeric">({returnedStep.actedAt.slice(0, 10)})</span>
              </>
            )}
          </p>
          <p style={{ marginBottom: 'var(--space-2)' }}>
            “{returnedStep.reason ?? 'No reason recorded.'}”
          </p>
          <p className="screen-meta" style={{ marginBottom: 0 }}>
            Items changed since the return are marked “Edited since return” below.
          </p>
        </section>
      )}

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

      {needsRecovery && (
        <section className="dialog" aria-labelledby="conflict-heading" data-testid="conflict-panel">
          <h2 id="conflict-heading">
            <span aria-hidden="true">⚠</span> {counts.conflict + counts.failed} entr
            {counts.conflict + counts.failed === 1 ? 'y' : 'ies'} could not be applied
          </h2>
          {hasConflict ? (
            <p>
              The server has a newer version of this job than this device did when these entries
              were made — usually because it was edited elsewhere, or its state changed (returned,
              voided or verified) while this device was offline. Nothing has been lost: the entries
              are held on this device, but they cannot be sent as-is, and Submit stays blocked until
              you decide.
            </p>
          ) : (
            // H-3: the non-409 class — the server REFUSED these entries
            // (e.g. this job is no longer assigned to you, or an entry was
            // rejected as invalid). Sending them again unchanged cannot
            // succeed.
            <p>
              The server refused {counts.failed === 1 ? 'this entry' : 'these entries'} — for
              example because this job is no longer assigned to you, or an entry was rejected as
              invalid. Nothing has been lost: {counts.failed === 1 ? 'it is' : 'they are'} held on
              this device, but re-sending unchanged cannot succeed, and Submit stays blocked until
              you decide.
            </p>
          )}
          {recoveryBanner && (
            <p className="banner" data-tone="info" role="status">
              <span aria-hidden="true">ℹ</span> {recoveryBanner}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={recovering || !isOnline}
              onClick={() => void recoverConflicts('keep-mine')}
            >
              {recovering ? 'Recovering…' : 'Keep my entries and resend'}
            </button>
            <button
              type="button"
              disabled={recovering || !isOnline}
              onClick={() => void recoverConflicts('accept-server')}
            >
              Discard mine, use the server’s
            </button>
          </div>
          {!isOnline && (
            <p className="field-hint" style={{ marginTop: 'var(--space-2)' }}>
              Recovery needs a connection — both options first fetch the server’s current version of
              this job.
            </p>
          )}
        </section>
      )}
      {!needsRecovery && recoveryBanner && (
        <p className="banner" data-tone="good" role="status">
          <span aria-hidden="true">✓</span> {recoveryBanner}
        </p>
      )}

      <section aria-label="Checklist items">
        <h2 className="microlabel" style={{ marginBottom: 'var(--space-3)' }}>
          Checklist
        </h2>
        {items.map((item) => (
          <div className="checklist-item" key={item.id}>
            <p className="checklist-instruction">
              <span className="item-no">{item.itemNo}</span>
              <span>{item.instruction}</span>
              {editedSinceReturn(item.id) && (
                <span className="status-chip" data-tone="info">
                  <span aria-hidden="true">✎</span>
                  <span>Edited since return</span>
                </span>
              )}
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
          <h2 className="microlabel" style={{ marginBottom: 'var(--space-3)' }}>
            Measurements
          </h2>
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

      <section aria-label="Photos">
        <h2 className="microlabel" style={{ marginBottom: 'var(--space-3)' }}>
          Photos
        </h2>
        {serverAttachments.length > 0 && (
          <ul className="data-list" style={{ marginBottom: 'var(--space-3)' }}>
            {serverAttachments.map((att) => (
              <li key={att.id} className="card">
                <div className="card-row">
                  <span className="job-code">{att.originalFilename ?? 'photo'}</span>
                  <span className="status-chip" data-tone="good">
                    <span aria-hidden="true">✓</span>
                    <span>On server</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {photos.length > 0 && (
          <ul className="data-list" style={{ marginBottom: 'var(--space-3)' }}>
            {photos.map((photo) => (
              <li key={photo.key} className="card" data-testid="staged-photo">
                <div className="card-row">
                  <img
                    src={photo.previewUrl}
                    alt={`Preview of ${photo.file.name}`}
                    style={{
                      width: '72px',
                      height: '72px',
                      objectFit: 'cover',
                      borderRadius: 'var(--radius-1)',
                      border: 'var(--border-width) solid var(--color-border)',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="job-code" style={{ marginBottom: 'var(--space-1)' }}>
                      {photo.file.name}
                    </p>
                    {photo.state === 'staged' && (
                      <span className="status-chip" data-tone="neutral">
                        <span aria-hidden="true">◯</span>
                        <span>Not uploaded yet</span>
                      </span>
                    )}
                    {photo.state === 'uploading' && (
                      <div className="progress-plate" role="status">
                        <p className="screen-meta" style={{ marginBottom: 'var(--space-1)' }}>
                          Uploading…{' '}
                          <span className="numeric">{Math.round(photo.progress * 100)}%</span>
                        </p>
                        <div className="progress-track" aria-hidden="true">
                          <div
                            className="progress-fill"
                            style={{ width: `${photo.progress * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {photo.state === 'uploaded' && (
                      <span className="status-chip" data-tone="good">
                        <span aria-hidden="true">✓</span>
                        <span>Received by server</span>
                      </span>
                    )}
                    {photo.state === 'failed' && (
                      <p className="field-error" role="alert">
                        {photo.error}
                      </p>
                    )}
                  </div>
                </div>
                {photo.state !== 'uploaded' && (
                  <div className="card-row" style={{ marginTop: 'var(--space-2)' }}>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!isOnline || photo.state === 'uploading'}
                      onClick={() => void uploadPhoto(photo.key)}
                    >
                      {photo.state === 'failed' ? 'Retry upload' : 'Upload photo'}
                    </button>
                    <button
                      type="button"
                      disabled={photo.state === 'uploading'}
                      onClick={() => removePhoto(photo.key)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {isOnline ? (
          <div className="field">
            <label htmlFor="photo-input">Add a photo (camera or gallery)</label>
            <input
              id="photo-input"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => stagePhotos(e.target.files)}
            />
            <p className="field-hint">
              Photos upload directly to the server — they are not held offline.
            </p>
          </div>
        ) : (
          <p className="banner" data-tone="info">
            <span aria-hidden="true">◌</span> Photos need a connection — they upload directly to the
            server and are not held offline. Reconnect to add photos; your checklist entries are
            unaffected and safely held on this device.
          </p>
        )}
      </section>

      {signing && (
        <section
          className="dialog"
          aria-labelledby="perform-sign-heading"
          data-testid="performer-signature"
        >
          <h2 id="perform-sign-heading">Sign to submit</h2>
          <p>
            By signing you confirm you carried out this maintenance and that the results recorded
            above are yours. Draw your signature below with a stylus, finger or mouse.
          </p>
          <SignaturePad
            disabled={submitting}
            onCancel={() => setSigning(false)}
            onDone={(pngDataUrl) => void handleSubmit(pngDataUrl)}
          />
        </section>
      )}

      <div className="action-bar">
        {photosAwaitingAction && !uploadsInFlight && (
          <p className="field-hint" style={{ marginBottom: 'var(--space-2)' }}>
            Upload or remove the photos above before submitting — submitting now would silently
            discard them.
          </p>
        )}
        <button
          type="button"
          className="btn-primary btn-block btn-capture"
          disabled={!canSubmit || submitting || signing}
          onClick={() => {
            setSubmitBanner(null);
            setSigning(true);
          }}
        >
          {submitting
            ? 'Submitting…'
            : uploadsInFlight
              ? 'Uploading photo…'
              : needsRecovery
                ? 'Resolve the sync problem above to submit'
                : counts.sendable > 0
                  ? `Sending ${counts.sendable} entr${counts.sendable === 1 ? 'y' : 'ies'}…`
                  : 'Sign and submit'}
        </button>
      </div>

      <dialog ref={leaveConfirmRef} className="dialog" aria-labelledby="leave-confirm-heading">
        <h2 id="leave-confirm-heading">
          <span aria-hidden="true">⚠</span> {pendingPhotoCount} photo
          {pendingPhotoCount === 1 ? '' : 's'} not uploaded
        </h2>
        <p>
          Photos are not held offline — leaving this screen discards the ones that have not been
          uploaded. Your checklist entries are unaffected.
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => leaveConfirmRef.current?.close()}
          >
            Stay on this record
          </button>
          <button
            type="button"
            onClick={() => {
              leaveConfirmRef.current?.close();
              navigate('/jobs');
            }}
          >
            Leave and discard
          </button>
        </div>
      </dialog>
    </main>
  );
}
