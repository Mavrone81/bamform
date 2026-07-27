import { useCallback, useEffect, useRef, useState } from 'react';
import { beginMfaEnrolment, confirmMfaEnrolment } from '../auth';
import { QrCode } from './QrCode';
import type { components } from '../api/generated/openapi-types';

type MfaEnrolResponse = components['schemas']['MfaEnrolResponse'];

type Phase = 'loading' | 'scan' | 'blocked';

/**
 * TOTP enrolment: scan and confirm (brief §2.2).
 *
 * Used inline by `SignIn` when the server answers a login with
 * `mfaRequired: true, mfaEnrolled: false` — the user cannot finish signing in
 * until they enrol, and confirming the first code both enrols them and
 * completes that login (`MfaEnrolConfirmResponse.auth`).
 *
 * The ten recovery codes that come back from the confirmation are NOT shown
 * here. Applying the `AuthResult` authenticates the app and `App` replaces
 * the sign-in screen immediately, so this component is unmounted at the exact
 * moment the codes arrive; they are latched in `auth/recovery-codes-store.ts`
 * and rendered by `screens/RecoveryCodes.tsx` instead.
 *
 * Nothing here is persisted or logged: the secret, the `otpauth://` URI and
 * the typed code live in component state for the life of the screen and
 * nowhere else.
 */
export function MfaEnrolment({
  onBlocked,
}: {
  /** Enrolment cannot proceed on this credential (already enrolled, challenge
   * expired, offline) — the caller decides where the user goes next. */
  onBlocked: (message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [enrolment, setEnrolment] = useState<MfaEnrolResponse | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `onBlocked` is an inline arrow in the parent, so its identity changes on
  // every parent render. Held in a ref so `start` can stay dependency-free:
  // if it were a dependency, the mount effect below would re-run on every
  // parent re-render and mint a brand-new pending secret each time —
  // invalidating whatever the user had just scanned.
  const onBlockedRef = useRef(onBlocked);
  useEffect(() => {
    onBlockedRef.current = onBlocked;
  }, [onBlocked]);

  const start = useCallback(async () => {
    setPhase('loading');
    setError(null);
    setTotpCode('');
    // Re-calling /auth/mfa/enrol REPLACES the pending secret server-side,
    // which is precisely what a user who half-scanned and gave up needs.
    const result = await beginMfaEnrolment();
    if (result.ok) {
      setEnrolment(result.value);
      setPhase('scan');
      return;
    }
    setPhase('blocked');
    if (result.status === 0) {
      onBlockedRef.current(
        'You appear to be offline. Setting up an authenticator needs a connection.',
      );
    } else if (result.status === 409) {
      onBlockedRef.current(
        'This account already has an authenticator set up. Sign in again and enter a code from it, or ask an administrator to reset it.',
      );
    } else {
      onBlockedRef.current(
        'Setting up an authenticator could not be started. Please sign in again.',
      );
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await confirmMfaEnrolment(totpCode);
      if (result.ok) {
        // Success unmounts this component: the recovery codes are latched and
        // `App` takes over. Nothing more to do here.
        return;
      }
      setTotpCode('');
      if (result.status === 0) {
        setError('You appear to be offline. Check your connection and try again.');
        return;
      }
      if (result.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
        return;
      }
      // 401 and 422 are deliberately indistinguishable on the server (it will
      // not say whether the code or the credential was wrong), so neither is
      // this message.
      setError('That code was not accepted. Check your authenticator and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading') {
    return (
      <section aria-label="Set up your authenticator">
        <h2>Set up your authenticator</h2>
        <p>Preparing…</p>
      </section>
    );
  }

  if (phase === 'blocked') {
    return (
      <section aria-label="Set up your authenticator">
        <h2>Set up your authenticator</h2>
        <p role="alert">Authenticator setup is not available right now.</p>
      </section>
    );
  }

  return (
    <section aria-label="Set up your authenticator">
      <h2>Set up your authenticator</h2>
      <p>
        Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator,
        1Password and similar all work), then enter the 6-digit code it shows.
      </p>
      {enrolment && (
        <>
          <div className="qr-frame">
            <QrCode value={enrolment.otpauthUri} describedBy="mfa-manual-entry" />
          </div>
          <div id="mfa-manual-entry" className="manual-entry">
            <p>
              <strong>Can&rsquo;t scan it?</strong> Add the account by hand with this setup key:
            </p>
            <p className="setup-key">
              <code>{enrolment.secret}</code>
            </p>
            <p>Type: time-based · Algorithm: SHA1 · Digits: 6 · Period: 30 seconds</p>
          </div>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleConfirm();
        }}
        noValidate
      >
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label htmlFor="enrol-totp-code">6-digit code from your authenticator</label>
          <input
            id="enrol-totp-code"
            name="one-time-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
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
          disabled={busy || totpCode.trim().length === 0}
          style={{ marginTop: 'var(--space-4)', width: '100%' }}
        >
          {busy ? 'Checking…' : 'Confirm and finish signing in'}
        </button>
      </form>
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        style={{ marginTop: 'var(--space-3)' }}
      >
        Start over with a new code
      </button>
    </section>
  );
}
