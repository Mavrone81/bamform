import { useEffect, useState, useCallback } from 'react';
import { getServices } from '../state/services';
import {
  bootstrap,
  listCachedJobs,
  jobSyncState,
  getClockSkew,
  type JobSyncState,
  type ClockSkewRecord,
} from '../offline/sync-engine';
import { onSynced } from '../offline/sync-events';
import type { CachedJob } from '../offline/db';
import { SyncStatusChip } from '../components/SyncStatusChip';
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
      <span aria-hidden="true">⚠</span> This device's clock is about {hours}h {direction} the server.
      Entries record both times so this is not lost, but times shown on this device may be
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

  const refresh = useCallback(async () => {
    const { db } = getServices();
    const jobs = await listCachedJobs(db);
    const withState = await Promise.all(
      jobs.map(async (job) => ({ job, syncState: await jobSyncState(db, job.id) })),
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
        if (summary.skewDetected) setClockSkew({ clockSkewMs: summary.clockSkewMs, skewDetected: true, serverTime: summary.serverTime, localTime: summary.localTimeAtBootstrap });
      })
      .catch(() => {
        if (!cancelled) setBootstrapError('Could not reach the server. Showing jobs already on this device.');
      })
      .finally(() => {
        if (!cancelled) void refresh();
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
      <h1 id="job-list-heading">Your jobs</h1>

      <p className="status-chip" data-tone={isOnline ? 'good' : 'attention'} role="status">
        <span aria-hidden="true">{isOnline ? '◉' : '◌'}</span>
        {isOnline ? 'Online' : 'Offline — work is saved on this device'}
      </p>

      {bootstrapError && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {bootstrapError}
        </p>
      )}
      {clockSkew && <ClockSkewBanner skew={clockSkew} />}

      {rows === null && <p>Loading…</p>}
      {rows !== null && rows.length === 0 && <p>No jobs assigned yet.</p>}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {rows?.map(({ job, syncState }) => (
          <li key={job.id}>
            <button
              type="button"
              className="card"
              style={{ width: '100%', textAlign: 'left', alignItems: 'stretch' }}
              onClick={() => navigate(`/jobs/${job.id}`)}
            >
              <div className="card-row">
                <span className="job-code">{job.job.jobNumber}</span>
                <span className="job-code">{job.job.assetCode}</span>
              </div>
              <div className="card-row">
                <span>Due {job.job.dueOn}</span>
                {job.job.overdue && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span> Overdue
                  </span>
                )}
              </div>
              <div className="card-row">
                <SyncStatusChip state={syncState} />
                {job.serverRemoved && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span> Reassigned — cannot submit
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
