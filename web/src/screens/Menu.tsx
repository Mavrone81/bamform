import { useEffect, useState } from 'react';
import { useRouter } from '../router';
import { getCurrentUser, onCurrentUserChange } from '../auth';
import { rolesGetQueueTab } from '../components/NavShell';

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

  const items: Array<{ label: string; to: string }> = [
    ...(hasQueueTab ? [] : [{ label: 'Verifier queue', to: '/queue' }]),
    { label: 'Delegations', to: '/delegations' },
    { label: 'Change password', to: '/change-password' },
    ...(isAdmin ? [{ label: 'Reset a user’s authenticator', to: '/admin/mfa-reset' }] : []),
  ];

  return (
    <main className="app-shell" aria-labelledby="menu-heading">
      <h1 id="menu-heading">Menu</h1>

      {user && (
        <div className="card identity-plate">
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
    </main>
  );
}
