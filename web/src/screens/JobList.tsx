import { useEffect, useState, useCallback } from 'react';
import { getServices } from '../state/services';
import { bootstrap, listCachedJobs, jobSyncState, watchOnlineAndDrain, type JobSyncState } from '../offline/sync-engine';
import type { CachedJob } from '../offline/db';
import { SyncStatusChip } from '../components/SyncStatusChip';
import { useRouter } from '../router';

interface Row {
  job: CachedJob;
  syncState: JobSyncState;
}

export function JobList() {
  const { navigate } = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

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
      .catch(() => {
        if (!cancelled) setBootstrapError('Could not reach the server. Showing jobs already on this device.');
      })
      .finally(() => {
        if (!cancelled) void refresh();
      });

    const unsubscribeDrain = watchOnlineAndDrain(db, transport, () => void refresh());
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      unsubscribeDrain();
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
