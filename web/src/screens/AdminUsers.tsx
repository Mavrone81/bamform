import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '../router';
import { listUsers, type AdminUser } from '../api/admin-client';

/**
 * Slice 13-UI-B — the user list (`GET /users`, ADMIN-only server-side).
 * Decrypted names/emails come from the API by design (PR-106: encrypted at
 * rest, readable through the authorised read path). A non-admin reaching
 * this URL gets the server's 403, surfaced honestly — the screen never
 * pre-judges (non-negotiable #6).
 */
export function AdminUsers() {
  const { navigate } = useRouter();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    const result = await listUsers(cursor ? { cursor } : undefined);
    if (result.ok) {
      setUsers((prev) => (cursor && prev ? [...prev, ...result.value.data] : result.value.data));
      setNextCursor(result.value.page.hasMore ? (result.value.page.nextCursor ?? null) : null);
      setError(null);
      return;
    }
    if (result.status === 0) {
      setError('Could not reach the server. User administration needs a connection.');
    } else {
      setError(
        result.problem?.detail ??
          result.problem?.title ??
          `The server refused this request (${result.status}).`,
      );
    }
    setUsers((prev) => prev ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="app-shell" aria-labelledby="admin-users-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/admin')}>
          <span aria-hidden="true">‹</span> Administration
        </button>
        <span className="microlabel">Administration</span>
        <div className="card-row">
          <h1 id="admin-users-heading" style={{ marginBottom: 0 }}>
            Users
          </h1>
          <button
            type="button"
            className="btn-primary"
            onClick={() => navigate('/admin/users/new')}
          >
            Add user
          </button>
        </div>
      </header>

      {error && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      {users === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}

      {users !== null && users.length === 0 && !error && (
        <div className="empty-state">
          <span className="empty-state-glyph" aria-hidden="true">
            ⚙
          </span>
          <p className="empty-state-title">No users yet.</p>
          <p>Accounts you add will be listed here.</p>
        </div>
      )}

      <ul className="data-list">
        {users?.map((user) => (
          <li key={user.id}>
            <button
              type="button"
              className="card card-button"
              data-rule={user.active ? 'good' : 'neutral'}
              onClick={() => navigate(`/admin/users/${encodeURIComponent(user.id)}`)}
            >
              <div className="card-row">
                <span className="card-title">{user.fullName}</span>
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
              <div className="card-row">
                <span className="text-soft">{user.email}</span>
              </div>
              <div className="card-row">
                <span className="job-code text-soft">{user.roles.join(' · ') || 'No roles'}</span>
                <span className="job-code text-soft">
                  {user.areaIds.length === 0
                    ? 'All areas'
                    : `${user.areaIds.length} area${user.areaIds.length === 1 ? '' : 's'}`}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {nextCursor && (
        <button
          type="button"
          className="btn-block"
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void load(nextCursor).finally(() => setLoadingMore(false));
          }}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
