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
import { pendingCountForUser } from '../offline/outbox';
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
  const [unsentAtRisk, setUnsentAtRisk] = useState(0);
  const [legacyHold, setLegacyHold] = useState<LegacyHoldSummary | null>(null);
  /**
   * This device's own storage could not be read. Every read below is
   * fire-and-forget — they run from an effect and again after every drain —
   * so their rejections used to go nowhere at all, and each failure had its
   * own way of lying quietly:
   *
   * - `listCachedJobs` failing leaves `rows` at `null`, i.e. "Loading…" for
   *   ever, when nothing is still loading.
   * - `legacyHoldSummary` and the storage-persistence pair exist ONLY to warn
   *   about unsent work at risk. A warning that silently fails to appear is
   *   worse than no warning: the screen looks like a clean bill of health.
   *
   * `bootstrapError` is deliberately not reused — that one says the SERVER
   * could not be reached and the device's own copy is being shown instead,
   * which is the opposite claim to this one.
   */
  const [deviceReadFailed, setDeviceReadFailed] = useState(false);

  const refresh = useCallback(async () => {
    const { db } = getServices();
    const userId = getSyncUserId();
    if (!userId) return; // signed out mid-flight — nothing to show
    // SYS-15: re-read on every refresh — App's sign-in request may resolve
    // after this screen first mounted (it notifies via sync-events).
    //
    // Gated on ACTUAL RISK (owner feedback, real device, 2026-07-28): the
    // warning used to fire on refused persistence alone, so a phone holding
    // nothing announced that "records held on this device could be evicted"
    // — warning about the loss of records that did not exist. Crying wolf on
    // the first screen a technician sees is how real warnings get ignored.
    // Eviction can only destroy work that is UNSENT, so that is the trigger.
    void Promise.all([getStoragePersistence(db), pendingCountForUser(db, userId)])
      .then(([outcome, pending]) => {
        setStorageUnprotected(Boolean(outcome && !outcome.persisted) && pending > 0);
        setUnsentAtRisk(pending);
      })
      .catch(() => setDeviceReadFailed(true));
    // H-4: pre-upgrade work quarantined for OTHER users must be visible,
    // not silently parked in IndexedDB.
    void legacyHoldSummary(db)
      .then((summary) => {
        setLegacyHold(summary.count > 0 ? summary : null);
      })
      .catch(() => setDeviceReadFailed(true));
    let withState: Row[];
    try {
      const jobs = await listCachedJobs(db, userId);
      withState = await Promise.all(
        jobs.map(async (job) => ({ job, syncState: await jobSyncState(db, userId, job.id) })),
      );
    } catch {
      // `refresh` is only ever invoked floating (`void refresh()` from the
      // effect and from `onSynced`), so this rejection had nowhere to go and
      // left the screen spinning on "Loading…" with nothing retrying.
      setDeviceReadFailed(true);
      return;
    }
    withState.sort((a, b) => {
      const aOverdue = a.job.job.overdue ? 0 : 1;
      const bOverdue = b.job.job.overdue ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      return a.job.job.dueOn.localeCompare(b.job.job.dueOn);
    });
    setDeviceReadFailed(false);
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
    void getClockSkew(db)
      .then((skew) => {
        if (!cancelled && skew?.skewDetected) setClockSkew(skew);
      })
      .catch(() => {
        if (!cancelled) setDeviceReadFailed(true);
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
          <span aria-hidden="true">⚠</span>{' '}
          {unsentAtRisk === 1 ? '1 record is' : `${unsentAtRisk} records are`} waiting to send, and
          this browser has not protected offline storage. Install BamForm (Add to Home Screen) to
          keep {unsentAtRisk === 1 ? 'it' : 'them'} safe, or connect to send now.
        </p>
      )}

      {deviceReadFailed && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> This device’s storage could not be read, so this list —
          and any warning about unsent work — may be incomplete. Nothing has been deleted. Close the
          app and open it again before starting a job.
        </p>
      )}

      {rows === null && !deviceReadFailed && (
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
