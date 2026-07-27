import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from '../router';
import { getCurrentUser, onCurrentUserChange } from '../auth';
import { BrandMark } from './BrandMark';

/**
 * The navigation shell (slice 14-DESIGN §3.2): bottom tab bar on phones,
 * graphite side rail on tablet/desktop. Both are rendered; CSS shows exactly
 * one per breakpoint, and the hidden one is `display:none` — absent from the
 * accessibility tree, so screen readers and tests only ever see a single
 * primary navigation.
 *
 * Tab visibility derives from the roles the SERVER returned on the current
 * user (current-user-store.ts). That is presentation, never enforcement
 * (non-negotiable #6): every route stays reachable by URL — and via the Menu
 * screen, which always lists the full destination set — the server refuses
 * anything the caller may not do. A MAINTAINER acting as a delegate reaches
 * the verifier queue through Menu; nothing is more than two taps away.
 */

/** Roles whose day job includes the verifier queue — they get the dedicated
 * tab. Everyone else still reaches the queue via Menu (delegates, auditors). */
export const VERIFIER_TAB_ROLES = ['TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const;

export function rolesGetQueueTab(roles: readonly string[] | undefined): boolean {
  return roles?.some((r) => (VERIFIER_TAB_ROLES as readonly string[]).includes(r)) ?? false;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/** Permanent, unobtrusive connectivity readout (§3.2). `aria-live` announces
 * the change without the `status` role, which stays reserved for the per-job
 * sync chips and result banners the tests assert on. */
function OnlineChip() {
  const online = useOnline();
  return (
    <span className="online-chip" data-tone={online ? 'good' : 'attention'} aria-live="polite">
      <span className="online-dot" aria-hidden="true" />
      <span>{online ? 'Online' : 'Offline'}</span>
    </span>
  );
}

function IconJobs() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="5"
        y="3.5"
        width="14"
        height="17"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M9 8.5h6M9 12h6M9 15.5h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconQueue() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3.5l7 3v5.2c0 4.2-2.9 7.2-7 8.8-4.1-1.6-7-4.6-7-8.8V6.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M8.8 12.2l2.3 2.3 4.3-4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMenu() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface NavItemDef {
  key: string;
  /** Short caption under the tab icon. */
  tabLabel: string;
  /** Full name — the rail's visible label and the tab's accessible name. */
  fullLabel: string;
  to: string;
  active: boolean;
  icon: ReactNode;
}

function navItems(path: string, showQueue: boolean): NavItemDef[] {
  const inQueueArea =
    path === '/queue' || path === '/delegations' || /^\/jobs\/[^/]+\/review$/.test(path);
  const inMenuArea = path === '/menu' || path === '/change-password' || path === '/admin/mfa-reset';
  const items: NavItemDef[] = [
    {
      key: 'jobs',
      tabLabel: 'Jobs',
      fullLabel: 'Jobs',
      to: '/jobs',
      active: !inQueueArea && !inMenuArea,
      icon: <IconJobs />,
    },
  ];
  if (showQueue) {
    items.push({
      key: 'queue',
      tabLabel: 'Queue',
      fullLabel: 'Verifier queue',
      to: '/queue',
      active: inQueueArea,
      icon: <IconQueue />,
    });
  }
  items.push({
    key: 'menu',
    tabLabel: 'Menu',
    fullLabel: 'Menu',
    to: '/menu',
    active: inMenuArea,
    icon: <IconMenu />,
  });
  return items;
}

export function NavShell({ children }: { children: ReactNode }) {
  const { path, navigate } = useRouter();
  const [user, setUser] = useState(() => getCurrentUser());
  useEffect(() => onCurrentUserChange(setUser), []);

  const items = navItems(path, rolesGetQueueTab(user?.roles));

  return (
    <div className="shell">
      <header className="appbar">
        <span className="brand-lockup">
          <BrandMark className="brand-mark" />
          <span className="brand-word">BamForm</span>
        </span>
        <OnlineChip />
      </header>

      <nav className="nav-rail" aria-label="Primary">
        <span className="brand-lockup">
          <BrandMark className="brand-mark" />
          <span className="brand-word">BamForm</span>
        </span>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="nav-item"
            aria-current={item.active ? 'page' : undefined}
            onClick={() => navigate(item.to)}
          >
            {item.icon}
            <span>{item.fullLabel}</span>
          </button>
        ))}
        <div className="nav-rail-foot">
          <OnlineChip />
          {user && (
            <>
              <span className="nav-rail-user">{user.fullName}</span>
              <span className="nav-rail-roles">{user.roles.join(' · ')}</span>
            </>
          )}
        </div>
      </nav>

      <div className="shell-main">{children}</div>

      <nav className="nav-tabs" aria-label="Primary">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className="nav-item"
            aria-label={item.fullLabel}
            aria-current={item.active ? 'page' : undefined}
            onClick={() => navigate(item.to)}
          >
            {item.icon}
            <span aria-hidden="true">{item.tabLabel}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
