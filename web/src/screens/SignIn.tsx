import { useEffect, useState, type FormEvent } from 'react';
import {
  abandonChallenge,
  challengeMillisRemaining,
  hasLiveChallenge,
  login,
  redeemRecoveryCode,
  verifyMfaCode,
  type AuthCallResult,
} from '../auth';
import { MfaEnrolment } from '../components/MfaEnrolment';
import { useRouter } from '../router';

/**
 * Sign-in, in up to two steps.
 *
 * Step one is unchanged. `POST /auth/login` has two possible 200 bodies now,
 * and which one arrives is decided ENTIRELY by the server
 * (`auth-client.ts#login` branches on the `mfaRequired` discriminator, never
 * on anything this screen knows — non-negotiable #6). With `MFA_ENABLED`
 * false, which is production today, the second body never occurs and this
 * screen behaves exactly as it did before slice 13: submit, land on `/jobs`.
 *
 * Step two only exists when the server asked for it:
 *  - already enrolled  → a 6-digit code, or a recovery code instead;
 *  - not yet enrolled  → enrolment inline, which also completes the login.
 *
 * The challenge token that authorises step two lives in memory for five
 * minutes (`challenge-store.ts`). Two things follow, and both are handled
 * here rather than left to the user to discover: a reload during step two
 * loses it, and it silently lapses. Either way the user is returned to the
 * password step with an explanation — brief §2.1, "never a dead end".
 */

type Step = 'password' | 'totp' | 'recovery' | 'enrol';

export function SignIn() {
  const { navigate } = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function restart(message: string) {
    abandonChallenge();
    setStep('password');
    setPassword('');
    setTotpCode('');
    setRecoveryCode('');
    setError(null);
    setNotice(message);
  }

  // The five-minute challenge lapses whether or not the user is looking at
  // the tab. Sending them back the moment it does beats letting them type a
  // code into a request that is already guaranteed to fail.
  useEffect(() => {
    if (step === 'password') return;
    const remaining = challengeMillisRemaining();
    const timer = window.setTimeout(
      () => restart('Your sign-in took too long and expired. Please enter your password again.'),
      remaining,
    );
    return () => window.clearTimeout(timer);
  }, [step]);

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const outcome = await login(email, password);
      if (outcome.kind === 'authenticated') {
        navigate('/jobs');
        return;
      }
      // The password was accepted but the login is not finished. Drop it from
      // component state now — it is of no further use and nothing should hold
      // a password longer than the request that carried it.
      setPassword('');
      setStep(outcome.mfaEnrolled ? 'totp' : 'enrol');
    } catch {
      // PR-007: the client never decides WHY auth failed (locked account,
      // wrong password, rate limited) — that judgement, and any detail
      // that could help an attacker enumerate accounts, stays server-side.
      setError('Sign-in failed. Check your email and password and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  /** Shared handling for the two second-step endpoints — both return the same
   * opaque 401 whether the code was wrong or the challenge was spent, so the
   * only honest way to tell the difference is to check whether OUR challenge
   * is still live. */
  function handleSecondStepFailure(result: AuthCallResult<unknown>, wrongCodeMessage: string) {
    if (result.status === 0) {
      setError('You appear to be offline. Signing in needs a connection.');
      return;
    }
    if (!hasLiveChallenge()) {
      restart('Your sign-in expired. Please enter your password again.');
      return;
    }
    if (result.status === 429) {
      setError('Too many attempts. Wait a minute and try again.');
      return;
    }
    setError(wrongCodeMessage);
  }

  async function handleTotpSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await verifyMfaCode(totpCode);
      if (result.ok) {
        navigate('/jobs');
        return;
      }
      setTotpCode('');
      handleSecondStepFailure(
        result,
        'That code was not accepted. Check your authenticator app and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRecoverySubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await redeemRecoveryCode(recoveryCode);
      if (result.ok) {
        navigate('/jobs');
        return;
      }
      setRecoveryCode('');
      handleSecondStepFailure(
        result,
        'That recovery code was not accepted. Each code works only once — try another.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell" aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading">BamForm</h1>
      <p>Preventive Maintenance Record and Approval System</p>

      {notice && (
        <p className="banner" data-tone="attention" role="alert">
          <span aria-hidden="true">⚠</span> {notice}
        </p>
      )}

      {step === 'password' && (
        <form onSubmit={handlePasswordSubmit} noValidate>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginTop: 'var(--space-4)' }}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting}
            style={{ marginTop: 'var(--space-5)', width: '100%' }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      {step === 'totp' && (
        <section aria-label="Two-step verification">
          <h2>Enter your 6-digit code</h2>
          <p>Open your authenticator app and enter the code it shows for BamForm.</p>
          <form onSubmit={handleTotpSubmit} noValidate>
            <div className="field">
              <label htmlFor="totp-code">6-digit code</label>
              <input
                id="totp-code"
                name="one-time-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
              />
            </div>
            {error && (
              <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || totpCode.trim().length === 0}
              style={{ marginTop: 'var(--space-4)', width: '100%' }}
            >
              {submitting ? 'Verifying…' : 'Verify'}
            </button>
          </form>
          <div className="card-row" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep('recovery');
              }}
            >
              Use a recovery code instead
            </button>
            <button type="button" onClick={() => restart('Signed out of this sign-in attempt.')}>
              Start again
            </button>
          </div>
        </section>
      )}

      {step === 'recovery' && (
        <section aria-label="Use a recovery code">
          <h2>Use a recovery code</h2>
          <p>
            Enter one of the ten codes you saved when you set up your authenticator. Each code works
            only once.
          </p>
          <form onSubmit={handleRecoverySubmit} noValidate>
            <div className="field">
              <label htmlFor="recovery-code">Recovery code</label>
              <input
                id="recovery-code"
                name="recovery-code"
                type="text"
                autoComplete="off"
                autoFocus
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
              />
            </div>
            {error && (
              <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || recoveryCode.trim().length === 0}
              style={{ marginTop: 'var(--space-4)', width: '100%' }}
            >
              {submitting ? 'Checking…' : 'Use recovery code'}
            </button>
          </form>
          <div className="card-row" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep('totp');
              }}
            >
              Back to the 6-digit code
            </button>
            <button type="button" onClick={() => restart('Signed out of this sign-in attempt.')}>
              Start again
            </button>
          </div>
        </section>
      )}

      {step === 'enrol' && <MfaEnrolment onBlocked={(message) => restart(message)} />}
    </main>
  );
}
