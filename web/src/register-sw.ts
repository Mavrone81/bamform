import { applyUpdate, startUpdateWatch } from './update';

/**
 * Registers the service worker, arms the update watch (`update.ts` — read
 * its module doc for the measured reason that watch has to exist at all) and
 * turns "a new worker took control of this page" into a reload.
 *
 * `controllerchange` fires the first time ANY worker takes control of a
 * previously-uncontrolled page too — i.e. on every brand-new visitor's very
 * first load, not only on a genuine update. Reloading then would be
 * pointless (there is no "old" JS running to be mismatched — the page that's
 * about to reload IS the current code) and was found, while building the
 * a11y suite, to race an axe-core scan running immediately after page load
 * (`page.evaluate` failing with "Execution context was destroyed").
 *
 * Slice 22 changed HOW that first claim is skipped. The previous version
 * attached the listener only when the page was ALREADY controlled at
 * registration time — which left a first-visit page with no listener at all,
 * so it could never notice a deploy for the rest of its session. In the
 * Android shell a session lasts until the process is killed (measured: two
 * launcher-icon relaunches do not re-navigate), so that was not a corner
 * case. The listener is now always attached and the first claim is skipped
 * by counting it, not by never listening.
 *
 * The reload itself goes through `applyUpdate()`, which holds it back while
 * the signature pad is open or a submit is in flight (PR-068 / O-12).
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  // A page that already has a controller has, by definition, had its first
  // claim; the very next controllerchange is a genuine update.
  let firstClaimSeen = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!firstClaimSeen) {
      firstClaimSeen = true;
      return;
    }
    // Idempotent, and gated: `applyUpdate` reloads at most once ever, and
    // never while the technician is mid-signature or mid-submit.
    applyUpdate();
  });

  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Registration failure (unsupported browser, disabled in settings, or an
    // insecure http:// origin — the plant-LAN case android's
    // network_security_config documents) degrades to "the app still works
    // online". It must never block the app from rendering.
  }

  // Armed even when registration FAILED, deliberately. Such a client has no
  // service worker to update — but it is still a single-page app that never
  // navigates, so it can still sit for a whole shift running JavaScript the
  // server has replaced. `checkForUpdate` falls back to comparing the served
  // `index.html`'s asset names against the ones this document loaded, which
  // needs no worker at all. Returning here instead would have left every
  // http:// deployment with exactly the bug this slice exists to fix.
  startUpdateWatch();
}
