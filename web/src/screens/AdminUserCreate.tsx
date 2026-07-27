import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from '../router';
import { createUser, listRoles, type Role, type RoleCode } from '../api/admin-client';

/**
 * Slice 13-UI-B — `POST /users` (ADMIN-only server-side). The password is
 * ADMIN-SET: there is no invite-email flow (no SMTP), and
 * `FORCE_PASSWORD_CHANGE_ENABLED` is off in production today, so the system
 * does NOT force the person to change it — the copy under the field says so
 * rather than letting the admin assume otherwise (brief §1.1).
 */
export function AdminUserCreate() {
  const { navigate } = useRouter();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [roleCodes, setRoleCodes] = useState<RoleCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listRoles().then((result) => {
      if (result.ok) setRoles(result.value.data);
      else setRoles([]);
    });
  }, []);

  function toggleRole(code: RoleCode) {
    setRoleCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await createUser({
        fullName: fullName.trim(),
        email: email.trim(),
        ...(employeeId.trim() ? { employeeId: employeeId.trim() } : {}),
        password,
        roleCodes,
      });
      if (result.ok) {
        navigate(`/admin/users/${encodeURIComponent(result.value.id)}`);
        return;
      }
      if (result.status === 0) {
        setError('Could not reach the server. Creating a user needs a connection.');
      } else {
        setError(
          result.problem?.detail ??
            result.problem?.title ??
            `The server refused this request (${result.status}).`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  const valid =
    fullName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 12 &&
    roleCodes.length > 0;

  return (
    <main className="app-shell app-shell--focus" aria-labelledby="admin-user-create-heading">
      <header className="screen-header">
        <button
          type="button"
          className="back-link btn-quiet"
          onClick={() => navigate('/admin/users')}
        >
          <span aria-hidden="true">‹</span> Users
        </button>
        <span className="microlabel">Administration</span>
        <h1 id="admin-user-create-heading" style={{ marginBottom: 0 }}>
          Add a user
        </h1>
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="user-full-name">Full name</label>
          <input
            id="user-full-name"
            type="text"
            autoComplete="off"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="user-email">Email</label>
          <input
            id="user-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="user-employee-id">Employee ID (optional)</label>
          <input
            id="user-employee-id"
            type="text"
            autoComplete="off"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="user-password">Initial password</label>
          <input
            id="user-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="user-password-hint"
          />
          <p className="field-hint" id="user-password-hint">
            At least 12 characters. You set this password and will know it — hand it over in person
            and ask the user to change it under Menu › Change password. The system does not force
            the change.
          </p>
        </div>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Roles</legend>
          {roles === null && (
            <p className="loading-state">
              <span className="loading-spinner" aria-hidden="true" />
              Loading roles…
            </p>
          )}
          {roles?.map((role) => (
            <div className="checkbox-field" key={role.code}>
              <input
                id={`role-${role.code}`}
                type="checkbox"
                checked={roleCodes.includes(role.code)}
                onChange={() => toggleRole(role.code)}
              />
              <label htmlFor={`role-${role.code}`}>
                {role.name} <span className="job-code text-soft">({role.code})</span>
              </label>
            </div>
          ))}
          {roles !== null && roleCodes.length === 0 && (
            <p className="field-hint">Pick at least one role.</p>
          )}
        </fieldset>

        {error && (
          <p className="banner" data-tone="bad" role="alert">
            <span aria-hidden="true">⚠</span> {error}
          </p>
        )}

        <button type="submit" className="btn-primary btn-block" disabled={!valid || submitting}>
          {submitting ? 'Creating…' : 'Create user'}
        </button>
      </form>
    </main>
  );
}
