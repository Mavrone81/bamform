import { useEffect, useState, useCallback } from 'react';
import { getServices, getSyncUserId } from '../state/services';
import {
  bootstrap,
  listCachedJobs,
  jobSyncState,
  getClockSkew,
  triggerDrainIfOnline,
  type JobSyncState,
  type ClockSkewRecord,
} from '../offline/sync-engine';
import { getStoragePersistence } from '../offline/persistence';
import { onSynced, notifySynced } from '../offline/sync-events';
import { legacyHoldSummary, type LegacyHoldSummary } from '../offline/db';
import type { CachedJob } from '../offline/db';
import { SyncStatusChip } from '../components/SyncStatusChip';
import { InstallHint } from '../components/InstallHint';
import { useRouter } from '../router';

interface Row {
  job: CachedJob;
  syncState: JobSyncState;
}

/** O-09: the skew check runs at every bootstrap, but the banner is only
 * ever this loud about it once per skew episode — re-showing it on every
 * background re-sync while the same skew persists would train technicians
 * to ignore it. */
function ClockSkewBanner({ skew }: { skew: ClockSkewRecord }) {
  const hours = Math.round((Math.abs(skew.clockSkewMs) / 3_600_000) * 10) / 10;
  const direction = skew.clockSkewMs > 0 ? 'ahead of' : 'behind';
  return (
    <p className="banner" data-tone="attention" role="alert">
      <span aria-hidden="true">⚠</span> This device's clock is about {hours}h {direction} the
      server. Entries record both times so this is not lost, but times shown on this device may be
      misleading until the clock is corrected.
    </p>
  );
}

export function JobList() {
  const { navigate } = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [clockSkew, setClockSkew] = useState<ClockSkewRecord | null>(null);
  const [storageUnprotected, setStorageUnprotected] = useState(false);
  const [legacyHold, setLegacyHold] = useState<LegacyHoldSummary | null>(null);

  const refresh = useCallback(async () => {
    const { db } = getServices();
    const userId = getSyncUserId();
    if (!userId) return; // signed out mid-flight — nothing to show
    // SYS-15: re-read on every refresh — App's sign-in request may resolve
    // after this screen first mounted (it notifies via sync-events).
    void getStoragePersistence(db).then((outcome) => {
      setStorageUnprotected(Boolean(outcome && !outcome.persisted));
    });
    // H-4: pre-upgrade work quarantined for OTHER users must be visible,
    // not silently parked in IndexedDB.
    void legacyHoldSummary(db).then((summary) => {
      setLegacyHold(summary.count > 0 ? summary : null);
    });
    const jobs = await listCachedJobs(db, userId);
    const withState = await Promise.all(
      jobs.map(async (job) => ({ job, syncState: await jobSyncState(db, userId, job.id) })),
    );
    withState.sort((a, b) => {
      const aOverdue = a.job.job.overdue ? 0 : 1;
      const bOverdue = b.job.job.overdue ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      return a.job.job.dueOn.localeCompare(b.job.job.dueOn);
    });
    setRows(withState);
  }, []);

  useEffect(() => {
    const { db, transport } = getServices();
    let cancelled = false;

    bootstrap(db, transport)
      .then((summary) => {
        if (cancelled) return;
        if (summary.skewDetected)
          setClockSkew({
            clockSkewMs: summary.clockSkewMs,
            skewDetected: true,
            serverTime: summary.serverTime,
            localTime: summary.localTimeAtBootstrap,
          });
      })
      .catch(() => {
        if (!cancelled)
          setBootstrapError('Could not reach the server. Showing jobs already on this device.');
      })
      .finally(() => {
        if (!cancelled) void refresh();
        // H-2: bootstrap may have just CLAIMED pre-upgrade legacy rows for
        // this principal (claimLegacyRows runs inside bootstrap). App's
        // sign-in drain fired before that claim, and on an always-online
        // device no further `online` transition will ever come — so the
        // claimed work would sit untransmitted all session. Drain now,
        // after the claim, unconditionally (a no-op when nothing is
        // drainable).
        const { db: drainDb, transport: drainTransport } = getServices();
        triggerDrainIfOnline(drainDb, drainTransport, getSyncUserId, () => notifySynced());
      });
    // Covers the case where a skew was recorded on an earlier bootstrap
    // this session and the banner should still be visible on remount.
    void getClockSkew(db).then((skew) => {
      if (!cancelled && skew?.skewDetected) setClockSkew(skew);
    });

    // The actual drain trigger is registered once, app-wide, in App.tsx —
    // this only re-renders the list whenever that (or any) drain completes,
    // wherever it was triggered from.
    const unsubscribeSynced = onSynced(() => void refresh());
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      unsubscribeSynced();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refresh]);

  return (
    <main className="app-shell" aria-labelledby="job-list-heading">
      <header className="screen-header">
        <span className="microlabel">Preventive maintenance</span>
        <h1 id="job-list-heading" style={{ marginBottom: 0 }}>
          Your jobs
        </h1>
      </header>

      <InstallHint />

      {!isOnline && (
        <p className="banner" data-tone="attention">
          <span aria-hidden="true">◌</span> Offline — work is saved on this device and sent when you
          reconnect.
        </p>
      )}
      {bootstrapError && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {bootstrapError}
        </p>
      )}
      {clockSkew && <ClockSkewBanner skew={clockSkew} />}
      {legacyHold && (
        <p className="banner" data-tone="info">
          <span aria-hidden="true">◍</span> {legacyHold.count} unsent entr
          {legacyHold.count === 1 ? 'y' : 'ies'} recorded before the app update
          {legacyHold.names.length > 0 ? ` belong to ${legacyHold.names.join(', ')} and` : ''} will
          be sent when the matching user signs in on this device. They are held safely and are not
          part of your work.
        </p>
      )}
      {storageUnprotected && (
        <p className="banner" data-tone="attention">
          <span aria-hidden="true">⚠</span> This browser has not protected BamForm's offline storage
          — records held on this device could be evicted if it runs low on space or sits unused.
          Installing the app (Add to Home Screen) protects them.
        </p>
      )}

      {rows === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}
      {rows !== null && rows.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-glyph" aria-hidden="true">
            ◇
          </span>
          <p className="empty-state-title">No jobs assigned yet.</p>
          <p>New preventive-maintenance jobs appear here as soon as they are assigned to you.</p>
        </div>
      )}

      <ul className="data-list">
        {rows?.map(({ job, syncState }) => (
          <li key={job.id}>
            <button
              type="button"
              className="card card-button"
              data-rule={job.job.overdue || job.serverRemoved ? 'bad' : 'neutral'}
              onClick={() => navigate(`/jobs/${job.id}`)}
            >
              <div className="card-row">
                <span className="card-title">{job.job.jobNumber}</span>
                <span className="job-code text-soft">{job.job.assetCode}</span>
              </div>
              <div className="card-row">
                <span className="numeric text-soft">Due {job.job.dueOn}</span>
                {job.job.overdue && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span>
                    <span>Overdue</span>
                  </span>
                )}
              </div>
              <div className="card-row">
                <SyncStatusChip state={syncState} />
                {job.serverRemoved && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span>
                    <span>Reassigned — cannot submit</span>
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
