import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { getServices } from '../state/services';
import { useRouter } from '../router';
import type { components } from '../api/generated/openapi-types';

type Delegation = components['schemas']['Delegation'];

const EMPTY_FORM = { delegatorId: '', delegateId: '', validFrom: '', validTo: '', reason: '' };

/**
 * Slice 11a/11b: a minimal delegation UI (PR-038/UR-052) — grant delegated
 * verification authority to cover an absence, and see/revoke active grants.
 * No authorisation decision happens here (non-negotiable #6): a
 * TEAM_LEADER/ENGINEER may only delegate their OWN authority away and only
 * ADMIN may set up a delegation between two other users — the server
 * enforces that and this form simply surfaces whatever `Problem` it returns
 * (e.g. 403) if the caller isn't allowed to.
 */
export function Delegations() {
  const { navigate } = useRouter();
  const [items, setItems] = useState<Delegation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { transport } = getServices();
      const page = await transport.getDelegations();
      setItems(page.data);
      setListError(null);
    } catch {
      setListError('Could not reach the server.');
      setItems((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const { transport } = getServices();
      const result = await transport.createDelegation({
        delegatorId: form.delegatorId,
        delegateId: form.delegateId,
        validFrom: new Date(form.validFrom).toISOString(),
        validTo: new Date(form.validTo).toISOString(),
        reason: form.reason || null,
      });
      if (result.ok) {
        setForm(EMPTY_FORM);
        void refresh();
      } else {
        setFormError(result.problem?.title ?? 'Could not create the delegation.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: string) {
    const { transport } = getServices();
    await transport.revokeDelegation(id);
    void refresh();
  }

  return (
    <main className="app-shell" aria-labelledby="delegations-heading">
      <div className="card-row">
        <h1 id="delegations-heading">Delegations</h1>
        <button type="button" onClick={() => navigate('/queue')}>
          Verifier queue
        </button>
      </div>

      {listError && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {listError}
        </p>
      )}

      <section aria-label="Grant a delegation">
        <h2>Grant delegated verification authority</h2>
        <form onSubmit={(e) => void handleCreate(e)} noValidate>
          <div className="field">
            <label htmlFor="delegatorId">Delegator user ID</label>
            <input
              id="delegatorId"
              required
              value={form.delegatorId}
              onChange={(e) => setForm((f) => ({ ...f, delegatorId: e.target.value }))}
            />
          </div>
          <div className="field" style={{ marginTop: 'var(--space-3)' }}>
            <label htmlFor="delegateId">Delegate user ID</label>
            <input
              id="delegateId"
              required
              value={form.delegateId}
              onChange={(e) => setForm((f) => ({ ...f, delegateId: e.target.value }))}
            />
          </div>
          <div className="field" style={{ marginTop: 'var(--space-3)' }}>
            <label htmlFor="validFrom">Valid from</label>
            <input
              id="validFrom"
              type="datetime-local"
              required
              value={form.validFrom}
              onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
            />
          </div>
          <div className="field" style={{ marginTop: 'var(--space-3)' }}>
            <label htmlFor="validTo">Valid to</label>
            <input
              id="validTo"
              type="datetime-local"
              required
              value={form.validTo}
              onChange={(e) => setForm((f) => ({ ...f, validTo: e.target.value }))}
            />
          </div>
          <div className="field" style={{ marginTop: 'var(--space-3)' }}>
            <label htmlFor="reason">Reason (optional)</label>
            <input
              id="reason"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </div>
          {formError && (
            <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {formError}
            </p>
          )}
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting}
            style={{ marginTop: 'var(--space-4)', width: '100%' }}
          >
            {submitting ? 'Creating…' : 'Create delegation'}
          </button>
        </form>
      </section>

      <section aria-label="Delegations">
        <h2>Your delegations</h2>
        {items === null && <p>Loading…</p>}
        {items !== null && items.length === 0 && <p>No delegations involve you.</p>}
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {items?.map((d) => (
            <li key={d.id} className="card">
              <div className="card-row">
                <span>
                  {d.delegatorName ?? d.delegatorId} → {d.delegateName ?? d.delegateId}
                </span>
                {d.revokedAt ? (
                  <span className="status-chip" data-tone="neutral">
                    Revoked
                  </span>
                ) : (
                  <span className="status-chip" data-tone="good">
                    Active
                  </span>
                )}
              </div>
              <div className="card-row">
                <span>
                  {new Date(d.validFrom).toLocaleString()} – {new Date(d.validTo).toLocaleString()}
                </span>
              </div>
              {!d.revokedAt && (
                <button type="button" onClick={() => void handleRevoke(d.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
