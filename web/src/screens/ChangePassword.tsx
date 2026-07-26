import { useState, type FormEvent } from 'react';
import { changePassword } from '../auth';
import { useRouter } from '../router';

/** Guidance only. The server owns the policy (`shared/src/mfa.ts`
 * `passwordChangeRequestSchema`: `newPassword` min 12, the same rule as
 * `/auth/login` and `POST /users`), re-validates every request, and its
 * verdict is what the user is shown when the two disagree. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * `POST /auth/password` — change your own password (brief §2.3).
 *
 * Two entry points, one screen:
 *  - voluntary, from the job list;
 *  - FORCED, rendered by `App` in place of everything else while the
 *    password-change latch is set. That latch is tripped centrally in
 *    `api/http-transport.ts` the first time the server answers
 *    `403 /errors/password-change-required`, which it does on every endpoint
 *    but three until the password is changed. Without this screen an
 *    admin-created user could sign in and then do nothing at all, with no
 *    explanation (review finding I-3).
 *
 * On success the server revokes the user's OTHER sessions and clears the
 * flag; this session survives, so `changePassword` releases the latch and the
 * user carries straight on rather than signing in again.
 */
export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const { navigate } = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const canSubmit =
    !submitting &&
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    newPassword === confirmPassword;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (result.ok) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        navigate('/jobs');
        return;
      }
      if (result.status === 0) {
        setError('You appear to be offline. Changing your password needs a connection.');
        return;
      }
      if (result.status === 401) {
        setError('Your current password was not accepted.');
        return;
      }
      if (result.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
        return;
      }
      // Anything else (422 policy, and whatever a future policy adds) is the
      // server's to explain — surfaced verbatim rather than paraphrased, so a
      // rule this screen does not know about is still actionable.
      setError(
        result.problem?.detail ?? result.problem?.title ?? 'The server rejected this password.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell" aria-labelledby="change-password-heading">
      <h1 id="change-password-heading">Change your password</h1>

      {forced ? (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> Your password was set by an administrator. Choose your
          own before you can use the system — nobody else should know the password you sign records
          with.
        </p>
      ) : (
        <button type="button" onClick={() => navigate('/jobs')} style={{ width: 'fit-content' }}>
          Back to your jobs
        </button>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            aria-describedby="new-password-hint"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <span id="new-password-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
        </div>
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>

        {tooShort && (
          <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
            Your new password must be at least {MIN_PASSWORD_LENGTH} characters.
          </p>
        )}
        {mismatch && (
          <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
            The two new passwords do not match.
          </p>
        )}
        {error && (
          <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn-primary"
          disabled={!canSubmit}
          style={{ marginTop: 'var(--space-5)', width: '100%' }}
        >
          {submitting ? 'Changing…' : 'Change password'}
        </button>
      </form>

      <p>Changing your password signs you out everywhere else. This device stays signed in.</p>
    </main>
  );
}
