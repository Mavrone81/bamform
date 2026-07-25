/**
 * Registers the service worker and reloads once when a NEW one takes
 * control of an ALREADY-controlled page (O-12) — sw.ts calls
 * `skipWaiting`/`clients.claim`, so this is the client-side half of "a
 * deploy cannot leave a client running mismatched code against a newer
 * API" (PR-068).
 *
 * `controllerchange` fires the first time ANY worker takes control of a
 * previously-uncontrolled page too — i.e. on every brand-new visitor's
 * very first load, not only on a genuine update. Reloading then would be
 * pointless (there is no "old" JS running to be mismatched — the page
 * that's about to reload IS the current code) and was found, while
 * building the a11y suite, to race an axe-core scan running immediately
 * after page load (`page.evaluate` failing with "Execution context was
 * destroyed"). Only reload when this page already had a controller before
 * this registration — that is what makes a controllerchange a genuine
 * "a newer deploy just took over mid-session" event rather than the
 * ordinary first claim.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  const alreadyControlled = Boolean(navigator.serviceWorker.controller);

  if (alreadyControlled) {
    // Guarded against a reload loop with a one-shot flag: a
    // controllerchange can in principle fire more than once in odd
    // browser states, and this must never become an infinite refresh.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  }

  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Registration failure (e.g. unsupported browser, disabled in
    // settings) degrades to "the app still works online" — it must never
    // block the app from rendering.
  }
}
