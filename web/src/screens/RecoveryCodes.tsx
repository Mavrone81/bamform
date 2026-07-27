import { useState } from 'react';
import { acknowledgeRecoveryCodes } from '../auth';

const RECOVERY_CODES_FILENAME = 'bamform-recovery-codes.txt';

/**
 * The one and only sight of the ten recovery codes (brief §2.2).
 *
 * Rendered by `App`, not by the enrolment component, and deliberately so:
 * confirming enrolment mid-login also completes the login, which unmounts the
 * sign-in screen the instant the codes arrive. See
 * `auth/recovery-codes-store.ts` for the full reasoning.
 *
 * The screen's job is to make the consequence unmistakable. There is no
 * endpoint that re-issues these; if they are lost along with the
 * authenticator, an ADMIN reset is the only way back, and that erases the
 * enrolment. So: a copy button, a download, and an explicit acknowledgement
 * that gates the only way forward. No "skip", no dismiss-by-navigation.
 */
export function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setError(null);
    } catch {
      // A denied clipboard permission (or an insecure origin) is not
      // something the user can fix here — the codes are on screen and the
      // download still works.
      setCopied(false);
      setError('Could not copy automatically. Select the codes and copy them, or download them.');
    }
  }

  function handleDownload() {
    const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = RECOVERY_CODES_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main
      className="app-shell app-shell--focus app-shell--standalone"
      aria-labelledby="recovery-codes-heading"
    >
      <header className="screen-header">
        <span className="microlabel">One-time step</span>
        <h1 id="recovery-codes-heading" style={{ marginBottom: 0 }}>
          Save your recovery codes
        </h1>
      </header>

      <p className="banner" data-tone="bad" role="alert">
        <span aria-hidden="true">⚠</span> These ten codes are shown once and can never be shown
        again. If you lose both your authenticator and these codes, an administrator must reset your
        access — which erases your setup and voids every code below.
      </p>
      <p>Each code works once. Store them somewhere separate from your phone.</p>

      <ul className="recovery-codes" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>

      <div className="card-row">
        <button type="button" onClick={() => void handleCopy()}>
          Copy codes
        </button>
        <button type="button" onClick={handleDownload}>
          Download codes
        </button>
      </div>

      <p role="status">{copied ? 'Copied to the clipboard.' : ''}</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <div className="field">
        <label htmlFor="recovery-saved" className="checkbox-field">
          <input
            id="recovery-saved"
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>I have saved these recovery codes somewhere safe.</span>
        </label>
      </div>

      <div className="action-bar">
        <button
          type="button"
          className="btn-primary btn-block btn-capture"
          disabled={!acknowledged}
          onClick={() => acknowledgeRecoveryCodes()}
        >
          Continue
        </button>
      </div>
    </main>
  );
}
