import { useState } from 'react';
import { resetUserMfa } from '../auth';
import { useRouter } from '../router';

/**
 * `POST /users/{userId}/mfa-reset` (brief §2.4) — the escape hatch for a user
 * who has lost both their authenticator and their recovery codes. Nothing
 * else can rescue them: no endpoint re-issues recovery codes and no endpoint
 * discloses a secret, to an administrator or to anyone.
 *
 * Deliberately minimal — the user table, search and the rest of the admin
 * surface are slice 13-UI-B, so this takes the user id directly. What it is
 * NOT minimal about is the consequence: the reset burns the subject's
 * enrolment and marks every unused recovery code used, so it is behind an
 * explicit confirmation that spells that out rather than a bare button.
 *
 * ADMIN-only is enforced by the SERVER (`@Roles('ADMIN')`). This screen is
 * reachable by URL for anyone and simply surfaces the 403 — non-negotiable #6:
 * the job list not offering the link to non-admins is presentation, never the
 * enforcement.
 */
export function AdminMfaReset() {
  const { navigate } = useRouter();
  const [userId, setUserId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleReset() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await resetUserMfa(userId.trim());
      if (result.ok) {
        setDone(
          `Multi-factor authentication was reset for ${userId.trim()}. They will be asked to set up a new authenticator the next time they sign in.`,
        );
        setUserId('');
        setConfirming(false);
        return;
      }
      if (result.status === 0) {
        setError('You appear to be offline. This action needs a connection.');
        return;
      }
      setError(
        result.problem?.detail ?? result.problem?.title ?? 'The server rejected this reset.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell" aria-labelledby="mfa-reset-heading">
      <div className="card-row">
        <h1 id="mfa-reset-heading">Reset a user&rsquo;s authenticator</h1>
        <button type="button" onClick={() => navigate('/jobs')}>
          Back to your jobs
        </button>
      </div>

      <p>
        Use this only when someone has lost both their authenticator app and their recovery codes.
        Nobody — including you — can read another person&rsquo;s authenticator secret or recovery
        codes, so a reset is the only way back in.
      </p>

      {done && (
        <p className="banner" data-tone="good" role="status">
          <span aria-hidden="true">✓</span> {done}
        </p>
      )}

      <div className="field">
        <label htmlFor="mfa-reset-user-id">User ID</label>
        <input
          id="mfa-reset-user-id"
          type="text"
          autoComplete="off"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setConfirming(false);
            setDone(null);
          }}
        />
      </div>

      {error && (
        <p className="banner" data-tone="bad" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}

      {!confirming ? (
        <button
          type="button"
          disabled={userId.trim().length === 0}
          onClick={() => setConfirming(true)}
          style={{ width: '100%' }}
        >
          Reset this user&rsquo;s authenticator
        </button>
      ) : (
        <section aria-label="Confirm reset" role="group">
          <p className="banner" data-tone="bad" role="alert">
            <span aria-hidden="true">⚠</span> This erases {userId.trim()}&rsquo;s authenticator
            setup and voids all ten of their recovery codes. They will be locked out until they
            enrol a new authenticator, and the action is recorded in the audit log against your
            name.
          </p>
          <div className="card-row">
            <button type="button" onClick={() => setConfirming(false)} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleReset()}
              disabled={submitting}
            >
              {submitting ? 'Resetting…' : 'Yes, reset it'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
