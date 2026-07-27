import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from '../router';
import {
  getUser,
  listAreas,
  listRoles,
  setUserAreaScopes,
  updateUser,
  type AdminUser,
  type Area,
  type Role,
  type RoleCode,
} from '../api/admin-client';
import { getCurrentUser, resetUserMfa } from '../auth';

/**
 * Slice 13-UI-B — one user's admin page: identity edit, role assignment
 * (soft-revoke replace semantics), deactivate/reactivate (the API's
 * last-admin 409 — SYS-11 — is surfaced verbatim, never pre-judged), area
 * scoping (`PUT /users/{id}/area-scopes`, SYS-10) and the MFA reset control
 * relocated here from the old standalone screen — the admin acts on the
 * person they are already looking at instead of retyping a UUID.
 */
export function AdminUserDetail({ userId }: { userId: string }) {
  const { navigate } = useRouter();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-section outcome surfaces (A-07: refusals are announced).
  const [identityMsg, setIdentityMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(
    null,
  );
  const [rolesMsg, setRolesMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [areasMsg, setAreasMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [mfaMsg, setMfaMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleCodes, setRoleCodes] = useState<RoleCode[]>([]);
  const [areaIds, setAreaIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [confirmingMfaReset, setConfirmingMfaReset] = useState(false);

  const applyUser = useCallback((next: AdminUser) => {
    setUser(next);
    setFullName(next.fullName);
    setEmail(next.email);
    setRoleCodes(next.roles);
    setAreaIds(next.areaIds);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [userRes, rolesRes, areasRes] = await Promise.all([
        getUser(userId),
        listRoles(),
        listAreas(),
      ]);
      if (cancelled) return;
      if (userRes.ok) {
        applyUser(userRes.value);
      } else if (userRes.status === 0) {
        setLoadError('Could not reach the server. User administration needs a connection.');
      } else {
        setLoadError(
          userRes.problem?.detail ??
            userRes.problem?.title ??
            `The server refused this request (${userRes.status}).`,
        );
      }
      if (rolesRes.ok) setRoles(rolesRes.value.data);
      if (areasRes.ok) setAreas(areasRes.value.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, applyUser]);

  function refusalText(status: number, problem?: { detail?: string; title?: string }): string {
    if (status === 0) return 'Could not reach the server. This change needs a connection.';
    return problem?.detail ?? problem?.title ?? `The server refused this change (${status}).`;
  }

  async function saveIdentity(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setIdentityMsg(null);
    try {
      const result = await updateUser(userId, { fullName: fullName.trim(), email: email.trim() });
      if (result.ok) {
        applyUser(result.value);
        setIdentityMsg({ tone: 'good', text: 'Saved.' });
      } else {
        setIdentityMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles() {
    setBusy(true);
    setRolesMsg(null);
    try {
      const result = await updateUser(userId, { roleCodes });
      if (result.ok) {
        applyUser(result.value);
        setRolesMsg({ tone: 'good', text: 'Roles saved.' });
      } else {
        setRolesMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveAreas() {
    setBusy(true);
    setAreasMsg(null);
    try {
      const result = await setUserAreaScopes(userId, areaIds);
      if (result.ok) {
        applyUser(result.value);
        setAreasMsg({
          tone: 'good',
          text:
            result.value.areaIds.length === 0
              ? 'Saved — this user now sees every area.'
              : 'Area access saved.',
        });
      } else {
        setAreasMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function setActive(active: boolean) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const result = await updateUser(userId, { active });
      if (result.ok) {
        applyUser(result.value);
        setStatusMsg({ tone: 'good', text: active ? 'Reactivated.' : 'Deactivated.' });
      } else {
        // SYS-11: "You are the last active ADMIN…" arrives here as a 409 —
        // shown verbatim, because the server's sentence explains the refusal
        // better than any summary would.
        setStatusMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
      setConfirmingDeactivate(false);
    }
  }

  async function doMfaReset() {
    setBusy(true);
    setMfaMsg(null);
    try {
      const result = await resetUserMfa(userId);
      if (result.ok) {
        setMfaMsg({
          tone: 'good',
          text: 'Authenticator reset. They will be asked to set up a new one at their next sign-in.',
        });
      } else if (result.status === 0) {
        setMfaMsg({
          tone: 'bad',
          text: 'You appear to be offline. This action needs a connection.',
        });
      } else {
        setMfaMsg({
          tone: 'bad',
          text:
            result.problem?.detail ?? result.problem?.title ?? 'The server rejected this reset.',
        });
      }
    } finally {
      setBusy(false);
      setConfirmingMfaReset(false);
    }
  }

  function toggleRole(code: RoleCode) {
    setRoleCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  function toggleArea(id: string) {
    setAreaIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  // Review B-3 (presentation only — the server enforces nothing about self
  // here and needs to enforce nothing): is the admin looking at themselves?
  const isSelf = user !== null && getCurrentUser()?.id === user.id;

  // Review B-4: ACTIVE areas are offered for assignment. A deactivated area
  // shows only while this user is still scoped to it (based on the SAVED
  // scopes, so the row does not vanish mid-edit) — it can be unticked, and
  // the API refuses any attempt to newly assign it.
  const selectableAreas = areas.filter(
    (area) => area.active || (user !== null && user.areaIds.includes(area.id)),
  );

  function sectionBanner(msg: { tone: 'good' | 'bad'; text: string } | null) {
    if (!msg) return null;
    return (
      <p className="banner" data-tone={msg.tone} role={msg.tone === 'bad' ? 'alert' : 'status'}>
        <span aria-hidden="true">{msg.tone === 'bad' ? '⚠' : '✓'}</span> {msg.text}
      </p>
    );
  }

  if (loadError) {
    return (
      <main className="app-shell" aria-labelledby="admin-user-heading">
        <header className="screen-header">
          <button
            type="button"
            className="back-link btn-quiet"
            onClick={() => navigate('/admin/users')}
          >
            <span aria-hidden="true">‹</span> Users
          </button>
          <span className="microlabel">Administration</span>
          <h1 id="admin-user-heading" style={{ marginBottom: 0 }}>
            User
          </h1>
        </header>
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {loadError}
        </p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="app-shell" aria-label="User">
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      </main>
    );
  }

  return (
    <main className="app-shell app-shell--focus" aria-labelledby="admin-user-heading">
      <header className="screen-header">
        <button
          type="button"
          className="back-link btn-quiet"
          onClick={() => navigate('/admin/users')}
        >
          <span aria-hidden="true">‹</span> Users
        </button>
        <span className="microlabel">Administration</span>
        <div className="card-row">
          <h1 id="admin-user-heading" style={{ marginBottom: 0 }}>
            {user.fullName}
          </h1>
          {user.active ? (
            <span className="status-chip" data-tone="good">
              <span aria-hidden="true">✓</span>
              <span>Active</span>
            </span>
          ) : (
            <span className="status-chip" data-tone="neutral">
              <span aria-hidden="true">⊘</span>
              <span>Deactivated</span>
            </span>
          )}
        </div>
        <span className="screen-meta">{user.employeeId ?? user.id}</span>
      </header>

      {/* ---- Identity ---- */}
      <section aria-labelledby="user-identity-heading" className="card">
        <h2 id="user-identity-heading">Identity</h2>
        <form onSubmit={(e) => void saveIdentity(e)} noValidate>
          <div className="field">
            <label htmlFor="edit-full-name">Full name</label>
            <input
              id="edit-full-name"
              type="text"
              autoComplete="off"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="edit-email">Email</label>
            <input
              id="edit-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {sectionBanner(identityMsg)}
          <button
            type="submit"
            disabled={busy || fullName.trim().length === 0 || email.trim().length === 0}
          >
            Save identity
          </button>
        </form>
      </section>

      {/* ---- Roles ---- */}
      <section aria-labelledby="user-roles-heading" className="card">
        <h2 id="user-roles-heading">Roles</h2>
        <p className="text-soft">
          Saving replaces the whole set. A removed role is revoked, not deleted — the grant history
          stays in the audit trail.
        </p>
        {roles.map((role) => (
          <div className="checkbox-field" key={role.code}>
            <input
              id={`edit-role-${role.code}`}
              type="checkbox"
              checked={roleCodes.includes(role.code)}
              onChange={() => toggleRole(role.code)}
            />
            <label htmlFor={`edit-role-${role.code}`}>
              {role.name} <span className="job-code text-soft">({role.code})</span>
            </label>
          </div>
        ))}
        {sectionBanner(rolesMsg)}
        <button
          type="button"
          disabled={busy || roleCodes.length === 0}
          onClick={() => void saveRoles()}
        >
          Save roles
        </button>
        {roleCodes.length === 0 && (
          <p className="field-hint">A user must hold at least one role.</p>
        )}
      </section>

      {/* ---- Area access ---- */}
      <section aria-labelledby="user-areas-heading" className="card">
        <h2 id="user-areas-heading">Area access</h2>
        <p className="text-soft">
          With no areas ticked this user sees <strong>every</strong> area. Ticking one or more
          restricts their jobs, queue, records and reports to those areas only.
        </p>
        {isSelf && (
          // Review B-3: no lockout exists (an admin can always PUT [] for
          // themselves, and /users administration is never area-scoped) but
          // the machines list and queue WOULD shrink to the ticked areas —
          // said out loud before it surprises them.
          <p className="banner" data-tone="attention" role="status">
            <span aria-hidden="true">⚠</span> This is your own account — restricting your areas also
            restricts what <em>you</em> see under Machines and in the queue. User administration
            itself is unaffected, and you can always clear your own restriction here.
          </p>
        )}
        {areas.length === 0 && (
          <p className="field-hint">
            No areas exist yet — create them under Administration › Areas first.
          </p>
        )}
        {selectableAreas.map((area) => (
          <div className="checkbox-field" key={area.id}>
            <input
              id={`area-${area.id}`}
              type="checkbox"
              checked={areaIds.includes(area.id)}
              onChange={() => toggleArea(area.id)}
            />
            <label htmlFor={`area-${area.id}`}>
              {area.name} <span className="job-code text-soft">({area.code})</span>
              {!area.active && (
                // Review B-4: a deactivated area cannot be NEWLY assigned
                // (the API 422s it) — it appears here only because this
                // user is still scoped to it, so it can be unticked.
                <span className="status-chip" data-tone="neutral">
                  <span aria-hidden="true">⊘</span>
                  <span>Deactivated</span>
                </span>
              )}
            </label>
          </div>
        ))}
        {sectionBanner(areasMsg)}
        <button type="button" disabled={busy} onClick={() => void saveAreas()}>
          Save area access
        </button>
      </section>

      {/* ---- Account status ---- */}
      <section aria-labelledby="user-status-heading" className="card">
        <h2 id="user-status-heading">Account status</h2>
        {sectionBanner(statusMsg)}
        {user.active ? (
          !confirmingDeactivate ? (
            <button type="button" disabled={busy} onClick={() => setConfirmingDeactivate(true)}>
              Deactivate this account
            </button>
          ) : (
            <div className="dialog" role="group" aria-label="Confirm deactivation">
              <p>
                {user.fullName} will no longer be able to sign in. Nothing is deleted — their
                records, signatures and history remain, and you can reactivate them here at any
                time.
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDeactivate(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-destructive"
                  disabled={busy}
                  onClick={() => void setActive(false)}
                >
                  Yes, deactivate
                </button>
              </div>
            </div>
          )
        ) : (
          <button type="button" disabled={busy} onClick={() => void setActive(true)}>
            Reactivate this account
          </button>
        )}
      </section>

      {/* ---- Authenticator ---- */}
      <section aria-labelledby="user-mfa-heading" className="card">
        <h2 id="user-mfa-heading">Authenticator</h2>
        <p className="text-soft">
          Use this only when {user.fullName} has lost both their authenticator app and their
          recovery codes. Nobody — including you — can read their secret or codes; a reset is the
          only way back in.
        </p>
        {sectionBanner(mfaMsg)}
        {!confirmingMfaReset ? (
          <button type="button" disabled={busy} onClick={() => setConfirmingMfaReset(true)}>
            Reset authenticator
          </button>
        ) : (
          <div className="dialog" role="group" aria-label="Confirm authenticator reset">
            <p className="banner" data-tone="bad" role="alert">
              <span aria-hidden="true">⚠</span> This erases {user.fullName}&rsquo;s authenticator
              setup and voids all of their recovery codes. They will be locked out until they enrol
              a new authenticator, and the action is recorded in the audit log against your name.
            </p>
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setConfirmingMfaReset(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-destructive"
                disabled={busy}
                onClick={() => void doMfaReset()}
              >
                Yes, reset it
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
