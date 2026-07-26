import { Component, type ReactNode } from 'react';

/**
 * The app's last resort, wrapped around every screen in `App`.
 *
 * WHY IT EXISTS (review finding I-1). React unmounts the entire root when a
 * render throws, and before this there was no boundary anywhere in `web/src`:
 * one unhandled throw turned the whole PWA into a blank tab, on a shop-floor
 * device with no devtools and no visible difference from a dead browser. The
 * specific throw that was reachable — an over-length `otpauth://` URI — is now
 * contained inside `QrCode` itself, which is the right layer for it: a
 * component that knows how to degrade should degrade rather than escalate.
 * This is only for what nobody predicted, and its job is limited to keeping
 * the user oriented and offering the one recovery a client can offer.
 *
 * ⚠️ It deliberately does NOT render the error, and does NOT log it. Screens
 * under this boundary handle passwords, TOTP codes, recovery codes and the
 * TOTP shared secret, and an error message can carry whatever was in scope
 * when it was thrown (non-negotiable #10). React's own dev-mode reporting is
 * the only place a developer sees it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-shell" aria-labelledby="app-error-heading">
        <h1 id="app-error-heading">Something went wrong</h1>
        <p role="alert">
          This screen could not be shown. Nothing you had already saved has been lost — work waiting
          to sync stays on this device until it reaches the server.
        </p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => window.location.reload()}
          style={{ marginTop: 'var(--space-4)' }}
        >
          Reload the app
        </button>
      </main>
    );
  }
}
