/**
 * Registers the service worker and reloads once when a new one takes
 * control (O-12) — sw.ts calls `skipWaiting`/`clients.claim`, so this is the
 * client-side half of "a deploy cannot leave a client running mismatched
 * code against a newer API" (PR-068). Guarded against a reload loop with a
 * one-shot flag: a controllerchange can in principle fire more than once in
 * odd browser states, and this must never become an infinite refresh.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Registration failure (e.g. unsupported browser, disabled in
    // settings) degrades to "the app still works online" — it must never
    // block the app from rendering.
  }
}
