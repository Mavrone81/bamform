import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from '../router';
import { createArea, listAreas, updateArea, type Area } from '../api/admin-client';

/**
 * Slice 13-UI-B — plant areas (`/areas`, endpoints from slice 4; POST/PATCH
 * are ADMIN-only server-side). Areas are what user scoping points at:
 * assigning them to users happens on each user's page (Area access). An
 * area is deactivated, never deleted — it may still be referenced by
 * machines and by history.
 */
export function AdminAreas() {
  const { navigate } = useRouter();
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [createMsg, setCreateMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editMsg, setEditMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listAreas();
    if (result.ok) {
      setAreas(result.value.data);
      setError(null);
      return;
    }
    if (result.status === 0) {
      setError('Could not reach the server. Area administration needs a connection.');
    } else {
      setError(
        result.problem?.detail ??
          result.problem?.title ??
          `The server refused this request (${result.status}).`,
      );
    }
    setAreas((prev) => prev ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function refusalText(status: number, problem?: { detail?: string; title?: string }): string {
    if (status === 0) return 'Could not reach the server. This change needs a connection.';
    return problem?.detail ?? problem?.title ?? `The server refused this change (${status}).`;
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setCreateMsg(null);
    try {
      const result = await createArea({ code: newCode.trim(), name: newName.trim() });
      if (result.ok) {
        setNewCode('');
        setNewName('');
        setCreateMsg({ tone: 'good', text: `Area ${result.value.name} created.` });
        await load();
      } else {
        setCreateMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(area: Area) {
    setBusy(true);
    setEditMsg(null);
    try {
      const result = await updateArea(area.id, { name: editName.trim() });
      if (result.ok) {
        setEditingId(null);
        await load();
      } else {
        setEditMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function setAreaActive(area: Area, active: boolean) {
    setBusy(true);
    setEditMsg(null);
    try {
      const result = await updateArea(area.id, { active });
      if (result.ok) {
        await load();
      } else {
        setEditMsg({ tone: 'bad', text: refusalText(result.status, result.problem) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell app-shell--focus" aria-labelledby="admin-areas-heading">
      <header className="screen-header">
        <button type="button" className="back-link btn-quiet" onClick={() => navigate('/admin')}>
          <span aria-hidden="true">‹</span> Administration
        </button>
        <span className="microlabel">Administration</span>
        <h1 id="admin-areas-heading" style={{ marginBottom: 0 }}>
          Areas
        </h1>
      </header>

      <p className="text-soft">
        Areas scope what users see. Assign them to a user under Users › Area access; machines are
        placed in an area on their own page.
      </p>

      <section aria-labelledby="area-create-heading" className="card">
        <h2 id="area-create-heading">Add an area</h2>
        <form onSubmit={(e) => void handleCreate(e)} noValidate>
          <div className="field">
            <label htmlFor="area-code">Code</label>
            <input
              id="area-code"
              type="text"
              autoComplete="off"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              aria-describedby="area-code-hint"
            />
            <p className="field-hint" id="area-code-hint">
              Short and stable, e.g. CLEAN-1 or WB-LINE.
            </p>
          </div>
          <div className="field">
            <label htmlFor="area-name">Name</label>
            <input
              id="area-name"
              type="text"
              autoComplete="off"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          {createMsg && (
            <p
              className="banner"
              data-tone={createMsg.tone}
              role={createMsg.tone === 'bad' ? 'alert' : 'status'}
            >
              <span aria-hidden="true">{createMsg.tone === 'bad' ? '⚠' : '✓'}</span>{' '}
              {createMsg.text}
            </p>
          )}
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || newCode.trim().length === 0 || newName.trim().length === 0}
          >
            Create area
          </button>
        </form>
      </section>

      {error && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      {areas === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}

      {areas !== null && areas.length === 0 && !error && (
        <div className="empty-state">
          <span className="empty-state-glyph" aria-hidden="true">
            ▦
          </span>
          <p className="empty-state-title">No areas yet.</p>
          <p>Until areas exist, every user sees everything.</p>
        </div>
      )}

      {editMsg && (
        <p className="banner" data-tone={editMsg.tone} role="alert">
          <span aria-hidden="true">⚠</span> {editMsg.text}
        </p>
      )}

      <ul className="data-list">
        {areas?.map((area) => (
          <li key={area.id}>
            <div className="card" data-rule={area.active ? 'good' : 'neutral'}>
              <div className="card-row">
                <span className="card-title">{area.name}</span>
                <span className="job-code text-soft">{area.code}</span>
              </div>
              {!area.active && (
                <div className="card-row">
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">⊘</span>
                    <span>Deactivated</span>
                  </span>
                </div>
              )}
              {editingId === area.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit(area);
                  }}
                  noValidate
                >
                  <div className="field">
                    <label htmlFor={`area-rename-${area.id}`}>Rename {area.code}</label>
                    <input
                      id={`area-rename-${area.id}`}
                      type="text"
                      autoComplete="off"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </div>
                  <div className="dialog-actions">
                    <button type="button" disabled={busy} onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={busy || editName.trim().length === 0}
                    >
                      Save name
                    </button>
                  </div>
                </form>
              ) : (
                <div className="dialog-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(area.id);
                      setEditName(area.name);
                      setEditMsg(null);
                    }}
                  >
                    Rename
                  </button>
                  {area.active ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void setAreaActive(area, false)}
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void setAreaActive(area, true)}
                    >
                      Reactivate
                    </button>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
