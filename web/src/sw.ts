/// <reference lib="webworker" />
export {};
declare const self: ServiceWorkerGlobalScope;

/**
 * BamForm service worker (PR-068 / O-12).
 *
 * `APP_VERSION` is a build-time literal (Vite replaces `import.meta.env.*`
 * at bundle time — see vite.sw.config.ts) sourced from `VITE_APP_VERSION`,
 * which web/Dockerfile sets to the image's build SHA. Every deploy therefore
 * produces a byte-different `dist/sw.js`, and web/nginx.conf serves `/sw.js`
 * with `Cache-Control: no-cache` — the browser always re-fetches and
 * byte-compares it, so a new deploy is detected promptly rather than a
 * stale worker being served indefinitely from HTTP cache.
 *
 * Strategy: app-shell (same-origin GET, non-API) cached
 * stale-while-revalidate under a version-named cache; every other cache
 * from a previous version is deleted on activate, and this worker claims
 * clients immediately so a technician who reconnects mid-session is not
 * left running JS built against an API shape a newer deploy has already
 * changed (this is the specific failure PR-068 exists to prevent).
 *
 * `/api/**` requests are never intercepted — those go straight to the
 * network so the outbox/sync machinery's own online/offline handling
 * (offline/sync-engine.ts) is the single source of truth for connectivity,
 * not a second, competing cache layer.
 */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
const CACHE_NAME = `bamform-shell-${APP_VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url: URL): boolean {
  return url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || isApiRequest(url)) {
    return; // network as normal — including all offline-outbox traffic
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) void cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => undefined);

      // Stale-while-revalidate: serve the cached shell instantly if we have
      // one (this is what makes the app usable offline after at least one
      // prior online visit), refresh it in the background either way.
      return cached ?? (await networkFetch) ?? Response.error();
    })(),
  );
});
