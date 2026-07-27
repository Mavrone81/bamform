import { useRouter } from '../router';

/**
 * Slice 13-UI-B — the admin landing, grown from the Menu's single admin
 * entry into a proper area. Entry visibility on the MENU is presentation;
 * this screen itself is URL-reachable by anyone (non-negotiable #6) — every
 * destination it links to surfaces the server's own 403 to a non-admin.
 *
 * The MFA-reset control now lives in each user's detail page where the
 * admin is already looking at the person (13-UI-B brief §1.1); the old
 * standalone screen stays routed at /admin/mfa-reset so a bookmark or
 * muscle memory still lands somewhere that works.
 */
export function AdminHome() {
  const { navigate } = useRouter();

  const items: Array<{ label: string; hint: string; to: string }> = [
    {
      label: 'Users',
      hint: 'Accounts, roles, area access, deactivation, authenticator resets',
      to: '/admin/users',
    },
    {
      label: 'Machines',
      hint: 'The machine list per asset type — add, confirm codes, edit',
      to: '/admin/machines',
    },
    {
      label: 'Areas',
      hint: 'Plant areas used to scope what users see',
      to: '/admin/areas',
    },
    {
      label: 'Delegations',
      hint: 'Absence cover for verifiers',
      to: '/delegations?from=menu',
    },
    {
      // Kept alongside the per-user control on each user's detail page: this
      // one takes a raw user ID, for when the account is known by ID alone.
      label: 'Reset a user’s authenticator',
      hint: 'By user ID — also on each user’s own page',
      to: '/admin/mfa-reset',
    },
  ];

  return (
    <main className="app-shell" aria-labelledby="admin-home-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/menu')}>
          <span aria-hidden="true">‹</span> Back to menu
        </button>
        <span className="microlabel">Administration</span>
        <h1 id="admin-home-heading" style={{ marginBottom: 0 }}>
          Administration
        </h1>
      </header>

      <nav aria-label="Administration sections">
        <ul className="menu-list">
          {items.map((item) => (
            <li key={item.to}>
              <button type="button" className="menu-item" onClick={() => navigate(item.to)}>
                <span>
                  <span style={{ display: 'block', fontWeight: 700 }}>{item.label}</span>
                  <span className="text-soft" style={{ display: 'block' }}>
                    {item.hint}
                  </span>
                </span>
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
