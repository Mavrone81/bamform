import { useEffect, useState } from 'react';
import { useRouter } from '../router';
import { getCurrentUser, onCurrentUserChange } from '../auth';
import { rolesGetQueueTab } from '../components/NavShell';
import { rolesCanRaiseJob, rolesCanAdjustSchedule } from '../lib/permissions';
import { SignOutControl } from '../components/SignOutControl';

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
  useEffect(() => onCurrentUserChange(setUser), []);

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

      {/* The side rail's foot (NavShell.tsx) carries the same control at
          >=768px; `.menu-signout` (global.css) hides this copy there so the
          two never both sit in the accessibility tree at once. Below 768px
          the rail is `display: none`, so this is the only route to sign
          out. */}
      <div className="menu-signout" style={{ marginTop: 'var(--space-5)' }}>
        <SignOutControl variant="menu" />
      </div>
    </main>
  );
}
