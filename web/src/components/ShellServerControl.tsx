import { useCallback, useEffect, useRef, useState } from 'react';
import { getDB } from '../offline/db';
import { pendingCountAll } from '../offline/outbox';

/**
 * The Android shell's server pointer — the owner's "point the mobile app at
 * the correct IP" control, living inside the sign-in screen rather than a
 * native pre-screen.
 *
 * Renders ONLY inside the BamForm Android shell. In a normal browser the
 * shell channel is undefined and this component renders nothing at all — it
 * must be absent from the DOM, not merely hidden.
 *
 * ## Transport: a message PORT, not an injected interface
 *
 * The first version of this control talked to an `addJavascriptInterface`
 * object (`window.BamFormShell.setServerUrl(...)`). The adversarial review
 * (A-1/A-2) demonstrated on an emulator that such an object is injected into
 * EVERY frame of the WebView and cannot express an origin rule: a
 * cross-origin `<iframe>`, and separately a cross-origin form POST, both
 * reached it and permanently re-pointed the app at an attacker's server with
 * zero user interaction.
 *
 * The shell now uses `WebViewCompat.addWebMessageListener` with an explicit
 * allow-list containing exactly the configured origin, so the channel object
 * only exists in documents from that origin (and the native side additionally
 * checks `sourceOrigin` + `isMainFrame` on every message). That API is
 * asynchronous and message-shaped, which is why everything below is
 * request/reply rather than a direct call — and why a failed switch can now
 * be reported INLINE instead of guessed at with a timer (review W-2).
 *
 * ## Why not admin-gated?
 *
 * The field has to be usable BEFORE anyone is signed in (it decides which
 * server sign-in even talks to), so there is no trustworthy identity to gate
 * on — and non-negotiable #6 forbids inventing client-side authorisation.
 * Shell-only visibility plus a collapsed disclosure is the honest
 * equivalent: technicians never notice it, the admin provisioning a device
 * finds it in two taps.
 */

/** The name the shell registers with `addWebMessageListener`. */
export const SHELL_CHANNEL = 'BamFormShell';

/** Bumped only on a breaking change to the message shapes below. */
export const SHELL_PROTOCOL_VERSION = 1;

/** The object `addWebMessageListener` injects — a subset of the DOM
 * EventTarget/postMessage shape. Deliberately structural: anything that does
 * not expose this exact pair is "not the shell". */
export interface ShellMessagePort {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** The port, or null when not running inside the shell. */
export function getShellPort(): ShellMessagePort | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as Record<string, unknown>)[SHELL_CHANNEL] as
    Partial<ShellMessagePort> | undefined;
  if (
    !candidate ||
    typeof candidate.postMessage !== 'function' ||
    typeof candidate.addEventListener !== 'function' ||
    typeof candidate.removeEventListener !== 'function'
  ) {
    return null;
  }
  return candidate as ShellMessagePort;
}

/**
 * Mirrors the shell's native normalisation (ServerConfig.normalize) so the
 * user gets an inline error instead of a doomed native round-trip: http(s)
 * only, no credentials-in-URL, a bare host/IP gets http://, and the result
 * is an origin (path/query dropped). Returns null when unusable.
 *
 * The native side re-normalises independently and is the sole enforcer —
 * this is a courtesy, never a control.
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

/**
 * How many unsent outbox rows this ORIGIN is holding (review W-1). Only ever
 * called from [handleConnect], i.e. only inside the shell — the browser path
 * returns before the control renders, so it never opens the database.
 */
export async function countUnsentOnThisOrigin(): Promise<number> {
  return pendingCountAll(getDB());
}

type Incoming =
  | { v: number; id: string; type: 'serverUrl'; url: string }
  | { v: number; id: string; type: 'switchResult'; ok: boolean; error?: string };

function parseIncoming(data: unknown): Incoming | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.v !== SHELL_PROTOCOL_VERSION) return null;
  if (typeof message.id !== 'string') return null;
  if (message.type === 'serverUrl' && typeof message.url === 'string') {
    return message as unknown as Incoming;
  }
  if (message.type === 'switchResult' && typeof message.ok === 'boolean') {
    return message as unknown as Incoming;
  }
  return null;
}

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `m${messageCounter}`;
}

/** null = "the outbox could not be read", which is NOT the same as zero. */
type OutboxWarning = { count: number | null; origin: string; target: string };

export interface ShellServerControlProps {
  /** Seam for tests; production uses the real per-origin outbox. */
  countUnsent?: () => Promise<number>;
}

export function ShellServerControl({
  countUnsent = countUnsentOnThisOrigin,
}: ShellServerControlProps = {}) {
  // The port is injected before any page script runs and never changes
  // within a document's lifetime, so sampling it once per mount is sound.
  const [port] = useState(getShellPort);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [warning, setWarning] = useState<OutboxWarning | null>(null);
  const pendingSwitchId = useRef<string | null>(null);

  useEffect(() => {
    if (!port) return;
    const requestId = nextId();
    const onMessage = (event: { data: unknown }) => {
      const message = parseIncoming(event.data);
      if (!message) return;
      if (message.type === 'serverUrl' && message.id === requestId) {
        setServerUrl(message.url);
        setValue(message.url);
        return;
      }
      if (message.type === 'switchResult' && message.id === pendingSwitchId.current) {
        pendingSwitchId.current = null;
        setChecking(false);
        // ok === true means the shell is about to reload this document from
        // the new origin; there is nothing useful left to render.
        if (!message.ok) setError(message.error || 'The shell could not switch to that server.');
      }
    };
    port.addEventListener('message', onMessage);
    port.postMessage(
      JSON.stringify({ v: SHELL_PROTOCOL_VERSION, id: requestId, type: 'getServerUrl' }),
    );
    return () => port.removeEventListener('message', onMessage);
  }, [port]);

  const postSwitch = useCallback(
    (target: string) => {
      if (!port) return;
      const id = nextId();
      pendingSwitchId.current = id;
      setWarning(null);
      setError(null);
      setChecking(true);
      port.postMessage(
        JSON.stringify({ v: SHELL_PROTOCOL_VERSION, id, type: 'setServerUrl', url: target }),
      );
    },
    [port],
  );

  // Nothing to show until the shell has told us where it is pointing. This
  // keeps the browser path (no port, no reply, ever) strictly empty.
  if (!port || serverUrl === null) return null;

  const normalized = normalizeServerUrl(value);
  const isHttp = normalized !== null && normalized.startsWith('http://');

  async function handleConnect() {
    if (checking || warning) return;
    const target = normalizeServerUrl(value);
    if (target === null) {
      setError(
        'Enter a valid server address, e.g. https://form.bevorasg.com or 192.168.1.50:8080.',
      );
      return;
    }
    setError(null);
    // The offline outbox lives in IndexedDB, which is per-ORIGIN: rows queued
    // against the current server do not travel to the new one and become
    // undrainable until the shell is pointed back. For an ISO-13485 record
    // system that is a data-integrity event, so it needs a decision, not a
    // toast (review W-1).
    let count: number | null;
    try {
      count = await countUnsent();
    } catch {
      count = null;
    }
    if (count === null || count > 0) {
      setWarning({ count, origin: serverUrl as string, target });
      return;
    }
    postSwitch(target);
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
        <span style={{ fontFamily: 'var(--font-mono)' }}>{hostOf(serverUrl)}</span>
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
                  void handleConnect();
                }
              }}
            />
            <p className="field-hint">
              Set by your administrator. The app loads BamForm from this server. Records still
              waiting to be sent stay with the server they were captured on.
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
          {warning && (
            <div
              role="alertdialog"
              aria-modal="false"
              aria-labelledby="shell-server-warning-title"
              className="banner"
              data-tone="attention"
              // .banner is a baseline-aligned flex ROW (built for "⚠ one
              // line of text"); this warning is a title + paragraph +
              // button pair, so it has to stack or the three children lay
              // out side by side and overflow the card. Verified on the
              // emulator at 1080px-wide / 360dp.
              style={{
                marginTop: 'var(--space-3)',
                flexDirection: 'column',
                alignItems: 'stretch',
                fontWeight: 400,
              }}
            >
              <p id="shell-server-warning-title" style={{ fontWeight: 600 }}>
                <span aria-hidden="true">⚠</span> Unsent records stay on {hostOf(warning.origin)}
              </p>
              <p style={{ marginTop: 'var(--space-2)' }}>
                {warning.count === null
                  ? `This device's outbox could not be checked, so there may be unsent records held for ${hostOf(warning.origin)}.`
                  : `${warning.count} unsent ${warning.count === 1 ? 'record is' : 'records are'} held on this device for ${hostOf(warning.origin)}.`}{' '}
                They are stored per server and will NOT move to {hostOf(warning.target)}. To send
                them, point this app back at {hostOf(warning.origin)} and let it sync first.
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                <button type="button" onClick={() => setWarning(null)} style={{ flex: 1 }}>
                  Keep this server
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => postSwitch(warning.target)}
                  style={{ flex: 1 }}
                >
                  Switch anyway
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={checking || warning !== null}
            style={{ marginTop: 'var(--space-3)', width: '100%' }}
          >
            {checking ? 'Checking server…' : 'Connect to this server'}
          </button>
          {checking && (
            <p className="field-hint" role="status" style={{ marginTop: 'var(--space-2)' }}>
              Checking the server. If it is reachable, BamForm reloads from it; if not, the app
              reports the failure here and nothing changes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
