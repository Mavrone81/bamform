import { useEffect, useRef, useState } from 'react';
import { useRouter } from '../router';
import { getCurrentUser, onCurrentUserChange, logout } from '../auth';
import { rolesGetQueueTab } from '../components/NavShell';
import { rolesCanRaiseJob, rolesCanAdjustSchedule } from '../lib/permissions';
import { getServices, getSyncUserId } from '../state/services';
import { pendingCountForUser } from '../offline/outbox';

/**
 * The shell's third tab (slice 14-DESIGN §3.2): everything that is not a
 * primary destination, one tap away, plus who is signed in. Item visibility
 * is presentation derived from the server-returned roles — never enforcement
 * (non-negotiable #6): every destination here stays reachable by URL and the
 * server refuses what the caller may not do. The "Verifier queue" entry
 * appears exactly for the roles that do NOT get the dedicated Queue tab, so
 * a MAINTAINER covering an absence as a delegate still reaches the queue in
 * two taps.
 */
export function Menu() {
  const { navigate } = useRouter();
  const [user, setUser] = useState(() => getCurrentUser());
  const [pendingCount, setPendingCount] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const warnDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => onCurrentUserChange(setUser), []);

  async function doSignOut() {
    setSigningOut(true);
    try {
      // The outbox is deliberately NOT touched (SYS-6: clearing it on
      // sign-out would destroy unsent work). The rows stay keyed under
      // this user's server-returned id; no other account can see or drain
      // them, and they resume sending when this user signs back in.
      await logout();
      // App's token listener flips to the sign-in screen from here.
    } finally {
      setSigningOut(false);
    }
  }

  async function onSignOutTapped() {
    const userId = getSyncUserId();
    let count: number;
    try {
      count = userId ? await pendingCountForUser(getServices().db, userId) : 0;
    } catch {
      // This runs from a `void`ed click handler, so a faulted IndexedDB used
      // to reject into nothing — the Sign out button simply did nothing, with
      // no way to tell that from a missed tap. SYS-6 says they must be TOLD
      // when unsent work would be stranded; if the count cannot be read we do
      // not know whether any is, so we show the warning rather than signing
      // out silently. `-1` marks "unknown" for the dialog's copy.
      count = -1;
    }
    if (count !== 0) {
      // SYS-6: they must be TOLD their work has not been transmitted yet.
      setPendingCount(count);
      warnDialogRef.current?.showModal();
      return;
    }
    await doSignOut();
  }

  const hasQueueTab = rolesGetQueueTab(user?.roles);
  const isAdmin = user?.roles.includes('ADMIN') ?? false;
  const canRaiseJob = rolesCanRaiseJob(user?.roles);
  const canAdjustSchedule = rolesCanAdjustSchedule(user?.roles);

  const items: Array<{ label: string; to: string }> = [
    ...(hasQueueTab ? [] : [{ label: 'Verifier queue', to: '/queue' }]),
    // Slice 18-WORKFLOW §2 — raising work off-plan. Presentation only: the
    // URL stays reachable for anyone and the server's `@Roles` gate is what
    // actually refuses (non-negotiable #6).
    ...(canRaiseJob ? [{ label: 'Raise a job', to: '/jobs/raise' }] : []),
    // Slice 29-SCHEDULE-UI review IMPORTANT-2 — PLANNER/TEAM_LEADER/ENGINEER
    // can adjust a schedule (`PUT /assets/{assetId}/schedule`) but are not
    // ADMIN, so the "Administration" entry below never reaches them. This is
    // the ONLY path to `MachineSchedules` that is not a typed-in URL; it
    // grants nothing beyond that one write, and ADMIN gets it here too
    // rather than only through the admin area.
    ...(canAdjustSchedule ? [{ label: 'Machine schedules', to: '/schedule' }] : []),
    // Slice 31-PLANNER — the year grid across every machine. Same gate as
    // "Machine schedules" above and for the same reason: it is the screen
    // where a PM plan is actually laid out, and the visits it opens are moved
    // through the very same `PUT /assets/{assetId}/schedule`. Offering it to a
    // role that cannot move anything would be offering a read-only wall chart
    // under a planning menu. Presentation only — `GET /schedule` itself is
    // open to every authenticated caller, and the URL stays reachable.
    ...(canAdjustSchedule ? [{ label: 'Maintenance plan', to: '/planner' }] : []),
    // `from=menu` lets the Delegations screen point its back link here
    // rather than at the queue (review D-4) — presentation only, the router
    // still matches on pathname alone.
    { label: 'Delegations', to: '/delegations?from=menu' },
    { label: 'Change password', to: '/change-password' },
    // Slice 13-UI-B: the single MFA-reset entry grew into the admin area
    // (users, machines, areas). The old /admin/mfa-reset screen stays routed
    // for bookmarks; its control also lives on each user's detail page now.
    ...(isAdmin ? [{ label: 'Administration', to: '/admin' }] : []),
  ];

  return (
    <main className="app-shell" aria-labelledby="menu-heading">
      <h1 id="menu-heading">Menu</h1>

      {user && (
        <div className="card identity-plate menu-identity">
          <span className="microlabel">Signed in as</span>
          <span style={{ fontWeight: 700 }}>{user.fullName}</span>
          <span className="job-code text-soft">{user.roles.join(' · ')}</span>
        </div>
      )}

      <nav aria-label="More destinations">
        <ul className="menu-list">
          {items.map((item) => (
            <li key={item.to}>
              <button type="button" className="menu-item" onClick={() => navigate(item.to)}>
                <span>{item.label}</span>
                <span className="chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <button
          type="button"
          className="btn-block"
          disabled={signingOut}
          onClick={() => void onSignOutTapped()}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>

      <dialog ref={warnDialogRef} className="dialog" aria-labelledby="signout-warn-heading">
        <h2 id="signout-warn-heading">
          <span aria-hidden="true">⚠</span>{' '}
          {pendingCount < 0 ? (
            <>Unsent entries on this device could not be counted</>
          ) : (
            <>
              {pendingCount} unsent entr{pendingCount === 1 ? 'y' : 'ies'} on this device
            </>
          )}
        </h2>
        <p>
          {pendingCount < 0
            ? 'This device’s storage could not be read, so we cannot tell whether any of your work is still waiting to send.'
            : 'Work you recorded has not reached the server yet.'}{' '}
          Signing out keeps anything held safely stored on this device under your account — nobody
          else can see or send it — but it will NOT be transmitted until you sign back in on this
          device with a connection.
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => warnDialogRef.current?.close()}
          >
            Stay signed in
          </button>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => {
              warnDialogRef.current?.close();
              void doSignOut();
            }}
          >
            Sign out anyway
          </button>
        </div>
      </dialog>
    </main>
  );
}
