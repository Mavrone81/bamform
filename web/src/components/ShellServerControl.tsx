import { useState } from 'react';

/**
 * The Android shell's server pointer — the owner's "point the mobile app at
 * the correct IP" control, living inside the sign-in screen rather than a
 * native pre-screen.
 *
 * Renders ONLY inside the BamForm Android shell, which injects
 * `window.BamFormShell` (see android/app/.../ShellBridge.kt). In a normal
 * browser the bridge is undefined and this component renders nothing at
 * all — it must be absent from the DOM, not merely hidden.
 *
 * Why not admin-gated? The field has to be usable BEFORE anyone is signed
 * in (it decides which server sign-in even talks to), so there is no
 * trustworthy identity to gate on — and non-negotiable #6 forbids inventing
 * client-side authorisation. Shell-only visibility plus a collapsed
 * disclosure is the honest equivalent: technicians never notice it, the
 * admin provisioning a device finds it in two taps.
 *
 * The confirm hands the URL to the shell, which health-checks
 * `<url>/api/v1/healthz` natively BEFORE switching; on success the WebView
 * reloads from the new origin (this page simply disappears), on failure the
 * shell reports natively and the current origin is untouched.
 */

export interface BamFormShellBridge {
  getServerUrl(): string;
  setServerUrl(url: string): void;
}

declare global {
  interface Window {
    BamFormShell?: BamFormShellBridge;
  }
}

/** The bridge, or null when not running inside the shell (or the injected
 * object does not honour the contract — treat that as "no shell"). */
export function getShellBridge(): BamFormShellBridge | null {
  const bridge = typeof window === 'undefined' ? undefined : window.BamFormShell;
  if (
    !bridge ||
    typeof bridge.getServerUrl !== 'function' ||
    typeof bridge.setServerUrl !== 'function'
  ) {
    return null;
  }
  return bridge;
}

/**
 * Mirrors the shell's native normalisation (ServerConfig.normalize) so the
 * user gets an inline error instead of a doomed native round-trip: http(s)
 * only, no credentials-in-URL, a bare host/IP gets http://, and the result
 * is an origin (path/query dropped). Returns null when unusable.
 */
export function normalizeServerUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.length > 2000) return null;
  if (!s.includes('://')) s = `http://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ShellServerControl() {
  // The bridge is injected before any page script runs and never changes
  // within a page's lifetime, so sampling it once per mount is sound.
  const [bridge] = useState(getShellBridge);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => bridge?.getServerUrl() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  if (!bridge) return null;

  const normalized = normalizeServerUrl(value);
  const isHttp = normalized !== null && normalized.startsWith('http://');

  function handleConnect() {
    if (!bridge || checking) return;
    const target = normalizeServerUrl(value);
    if (target === null) {
      setError(
        'Enter a valid server address, e.g. https://form.bevorasg.com or 192.168.1.50:8080.',
      );
      return;
    }
    setError(null);
    setChecking(true);
    bridge.setServerUrl(target);
    // On success the shell reloads this page from the new origin, so this
    // state never re-renders; on failure it reports natively and stays put —
    // re-arm the button once the outcome is surely in.
    window.setTimeout(() => setChecking(false), 10000);
  }

  return (
    <div
      style={{
        marginTop: 'var(--space-5)',
        borderTop: 'var(--border-width) solid var(--color-border)',
        paddingTop: 'var(--space-2)',
      }}
    >
      <button
        type="button"
        className="btn-quiet"
        aria-expanded={open}
        aria-controls="shell-server-panel"
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 'var(--text-xs)', color: 'var(--color-ink-faint)' }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Server:{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>{hostOf(bridge.getServerUrl())}</span>
      </button>
      {open && (
        <div id="shell-server-panel">
          <div className="field" style={{ marginTop: 'var(--space-3)' }}>
            <label htmlFor="shell-server-url">Server address</label>
            <input
              id="shell-server-url"
              name="shell-server-url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // This control lives inside the sign-in form; Enter here
                // must connect to the server, not submit credentials.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleConnect();
                }
              }}
            />
            <p className="field-hint">
              Set by your administrator. The app loads BamForm from this server.
            </p>
          </div>
          {isHttp && (
            <p className="banner" data-tone="attention" style={{ marginTop: 'var(--space-3)' }}>
              <span aria-hidden="true">⚠</span> No HTTPS: offline mode and installability are
              limited by the browser engine; use HTTPS for full offline support.
            </p>
          )}
          {error && (
            <p className="field-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={handleConnect}
            disabled={checking}
            style={{ marginTop: 'var(--space-3)', width: '100%' }}
          >
            {checking ? 'Checking server…' : 'Connect to this server'}
          </button>
          {checking && (
            <p className="field-hint" role="status" style={{ marginTop: 'var(--space-2)' }}>
              Checking the server. If it is reachable, BamForm reloads from it; if not, the app
              reports the failure and nothing changes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
