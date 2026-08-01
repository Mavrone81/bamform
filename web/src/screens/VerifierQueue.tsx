import { useCallback, useEffect, useState } from 'react';
import { getServices } from '../state/services';
import { useRouter } from '../router';
import type { components } from '../api/generated/openapi-types';

type QueueEntry = components['schemas']['QueueEntry'];

/**
 * Both stage numbers actually present as numbers. The contract makes them
 * required, and the server only queues records sitting at a CONFIGURED stage,
 * so this should always hold — but see the guard's note at the call site for
 * why the screen does not take that on trust.
 */
function hasStage(entry: QueueEntry): boolean {
  return typeof entry.stageOrdinal === 'number' && typeof entry.stageCount === 'number';
}

/** Only ever asked once `hasStage` is true, so this is a real numeric compare. */
function isFinalStage(entry: QueueEntry): boolean {
  return hasStage(entry) && entry.stageOrdinal >= entry.stageCount;
}

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
      <header className="screen-header">
        <span className="microlabel">Awaiting verification</span>
        <div className="card-row">
          <h1 id="queue-heading" style={{ marginBottom: 0 }}>
            Verifier queue
          </h1>
          <button type="button" onClick={() => navigate('/delegations')}>
            Delegations
          </button>
        </div>
      </header>

      {error && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      {entries === null && (
        <p className="loading-state">
          <span className="loading-spinner" aria-hidden="true" />
          Loading…
        </p>
      )}
      {entries !== null && entries.length === 0 && !error && (
        <div className="empty-state">
          <span className="empty-state-glyph" aria-hidden="true">
            ✓
          </span>
          <p className="empty-state-title">No records awaiting your verification.</p>
          <p>Submitted records that need your signature will queue here.</p>
        </div>
      )}

      <ul className="data-list">
        {entries?.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="card card-button"
              data-rule={entry.escalated ? 'bad' : 'attention'}
              onClick={() =>
                navigate(
                  entry.onBehalfOf
                    ? `/jobs/${entry.id}/review?onBehalfOf=${encodeURIComponent(entry.onBehalfOf)}`
                    : `/jobs/${entry.id}/review`,
                )
              }
            >
              <div className="card-row">
                <span className="card-title">{entry.jobNumber}</span>
                <span className="job-code text-soft">{entry.assetCode}</span>
              </div>
              <div className="card-row">
                <span className="numeric text-soft">
                  Submitted {new Date(entry.submittedAt).toLocaleString()}
                </span>
                {entry.escalated && (
                  <span className="status-chip" data-tone="bad">
                    <span aria-hidden="true">⚠</span>
                    <span>Escalated</span>
                  </span>
                )}
              </div>
              {/* Slice 26-TWOSTAGE — which of the route's stages this record
                  is waiting at. The route is two stages (team leader, then
                  engineer) and only the FINAL signature archives, so a
                  verifier must be able to see, before opening the record,
                  whose signature is being asked for and whether it is the
                  last one. A-05: icon + words, never colour alone.

                  Guarded on `typeof … === 'number'` rather than a truthiness
                  or `>=` test (review fix m1): `null >= null` is TRUE in
                  JavaScript — both sides coerce to 0 — so a response missing
                  these fields would otherwise render an empty chip AND claim
                  the signature archives the record. Saying nothing about the
                  stage is correct when we do not know it; making a false
                  claim about a controlled record never is. */}
              {hasStage(entry) && (
                <>
                  <div className="card-row">
                    <span
                      className="status-chip"
                      data-tone={isFinalStage(entry) ? 'attention' : 'info'}
                    >
                      <span aria-hidden="true">◧</span>
                      <span>
                        Stage {entry.stageOrdinal} of {entry.stageCount}
                      </span>
                    </span>
                    {entry.stageLabel && <span className="text-soft">{entry.stageLabel}</span>}
                  </div>
                  {isFinalStage(entry) && (
                    <div className="card-row">
                      <span className="microlabel">Final sign-off — archives the record</span>
                    </div>
                  )}
                </>
              )}
              {entry.onBehalfOf && (
                <div className="card-row">
                  <span className="status-chip" data-tone="info">
                    <span aria-hidden="true">◈</span>
                    <span>Acting on behalf of delegator</span>
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
