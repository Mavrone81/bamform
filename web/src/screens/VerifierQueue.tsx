import { useCallback, useEffect, useState } from 'react';
import { getServices } from '../state/services';
import { useRouter } from '../router';
import type { components } from '../api/generated/openapi-types';

type QueueEntry = components['schemas']['QueueEntry'];

/**
 * Slice 11a/11b: GET /queue — the caller's pending verifications, including
 * any active delegator's queue (each such entry carries `onBehalfOf`). A
 * non-verifier simply gets an empty page back from the server (not an
 * error, api/openapi.yaml `/queue`) — this screen just renders whatever
 * page it is given; no role check happens client-side (non-negotiable #6).
 */
export function VerifierQueue() {
  const { navigate } = useRouter();
  const [entries, setEntries] = useState<QueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { transport } = getServices();
      const page = await transport.getQueue();
      setEntries(page.data);
      setError(null);
    } catch {
      setError('Could not reach the server. Try again once you are back online.');
      setEntries((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="app-shell" aria-labelledby="queue-heading">
      <div className="card-row">
        <h1 id="queue-heading">Verifier queue</h1>
        <button type="button" onClick={() => navigate('/jobs')}>
          Your jobs
        </button>
      </div>
      <button
        type="button"
        onClick={() => navigate('/delegations')}
        style={{ width: 'fit-content' }}
      >
        Delegations
      </button>

      {error && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      {entries === null && <p>Loading…</p>}
      {entries !== null && entries.length === 0 && !error && (
        <p>No records awaiting your verification.</p>
      )}

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
        {entries?.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="card"
              style={{ width: '100%', textAlign: 'left', alignItems: 'stretch' }}
              onClick={() => navigate(`/jobs/${entry.id}/review`)}
            >
              <div className="card-row">
                <span className="job-code">{entry.jobNumber}</span>
                <span className="job-code">{entry.assetCode}</span>
              </div>
              <div className="card-row">
                <span>Submitted {new Date(entry.submittedAt).toLocaleString()}</span>
                {entry.escalated && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span> Escalated
                  </span>
                )}
              </div>
              {entry.onBehalfOf && (
                <div className="card-row">
                  <span className="status-chip" data-tone="neutral">
                    <span aria-hidden="true">◈</span> Acting on behalf of delegator
                  </span>
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
