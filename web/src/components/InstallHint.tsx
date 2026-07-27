import { useEffect, useState } from 'react';

/**
 * The installable-PWA hint (slice 14-DESIGN §3.4). Two platform paths:
 *
 *  - Chromium (Android/desktop): the browser fires `beforeinstallprompt`
 *    when its install criteria are met; we stash the event and offer a real
 *    "Install" button that calls `prompt()`.
 *  - iOS Safari: there is no prompt API at all — the only route is the Share
 *    sheet's "Add to Home Screen", so the hint says exactly that.
 *
 * Dismissal is persisted in localStorage — explicitly permitted by the brief
 * as the one new piece of persisted UI state (it is presentation, not a
 * token; non-negotiable #10 untouched). Shown once, never nags.
 */

const DISMISS_KEY = 'bamform.install-hint-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as { standalone?: boolean }).standalone)
  );
}

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === 'true';
  } catch {
    return true; // storage unavailable — never show rather than never stop
  }
}

export function InstallHint() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => wasDismissed());

  useEffect(() => {
    if (dismissed || isStandalone()) return;
    if (isIos()) {
      setShowIosHint(true);
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, [dismissed]);

  if (dismissed || (!installEvent && !showIosHint)) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, 'true');
    } catch {
      // Session-only dismissal is fine when storage is unavailable.
    }
    setDismissed(true);
  }

  return (
    <section className="install-hint" aria-label="Install BamForm">
      <p>
        <strong>Install BamForm on this device.</strong>{' '}
        {installEvent
          ? 'It opens full-screen from your home screen and keeps working offline on the plant floor.'
          : 'In Safari, open the Share menu and choose “Add to Home Screen”. It opens full-screen and keeps working offline.'}
      </p>
      <div className="install-hint-actions">
        {installEvent && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              void installEvent.prompt();
              dismiss();
            }}
          >
            Install app
          </button>
        )}
        <button type="button" onClick={dismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}
