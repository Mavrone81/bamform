/// <reference lib="webworker" />
export {};
declare const self: ServiceWorkerGlobalScope;
declare const __BAMFORM_BUILD_ID__: string;

/**
 * BamForm service worker (PR-068 / O-12 / slice 22-SELFUPDATE).
 *
 * ## The version, and why it is not `VITE_APP_VERSION` (review S-1)
 *
 * This file's cache name used to be `bamform-shell-${VITE_APP_VERSION}`, and
 * the doc here claimed "every deploy therefore produces a byte-different
 * `dist/sw.js`". That was false on the deployment it mattered on.
 * `docker-compose.yml` maps `VITE_APP_VERSION: ${IMAGE_TAG:-local}`,
 * `.env.example` sets `IMAGE_TAG=local`, and the droplet's deploy script
 * sources that `.env` and builds — so every deploy stamped the same constant.
 * Measured: two builds from genuinely different source produced a
 * byte-identical `sw.js` (`fe6d1732…` both times), which meant
 * `registration.update()` correctly reported "no change" on every trigger
 * forever, and a device could never leave an old build.
 *
 * `__BAMFORM_BUILD_ID__` is injected by vite.sw.config.ts from the content
 * hashes of the assets the app build just emitted. It changes if and only if
 * the app changed — no environment variable, no deploy script and no CI
 * setting can pin it by accident. `scripts/ci/assert-sw-changes-per-build.sh`
 * fails the build if that ever stops being true.
 *
 * ## Strategy
 *
 * - Navigations (the app shell document): **network-first**, cache as
 *   fallback. See the fetch handler for why this is not stale-while-
 *   revalidate any more.
 * - Hashed assets and everything else same-origin: stale-while-revalidate
 *   under a version-named cache, which is correct because those filenames are
 *   content-addressed — a given URL's bytes never change.
 * - Every cache from a previous version is deleted on activate, and this
 *   worker claims clients immediately.
 * - `/api/**` is never intercepted: the outbox/sync machinery's own
 *   online/offline handling (offline/sync-engine.ts) is the single source of
 *   truth for connectivity, not a second, competing cache layer.
 */
const CACHE_NAME = `bamform-shell-${__BAMFORM_BUILD_ID__}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

/**
 * Slice 22-SELFUPDATE: an escape hatch for a worker parked in `waiting`.
 *
 * `install` above already calls `skipWaiting()`, so under normal conditions
 * nothing ever reaches this. But "it should never happen" is what left a
 * device on stale code in the first place, and a worker whose install
 * handler threw would sit in `waiting` indefinitely with no way out —
 * a permanently stale client. `update.ts` sends this when it finds one.
 *
 * Messages on a service worker can only come from that worker's own clients
 * (same origin, by construction), so there is no origin decision to make
 * here — only a payload shape to validate, which this does before acting.
 */
self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'SKIP_WAITING'
  ) {
    void self.skipWaiting();
  }
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
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || isApiRequest(url)) {
    return; // network as normal — including all offline-outbox traffic
  }

  // A caller that explicitly asked to bypass HTTP caches means it, and this
  // cache is no exception. `update.ts`'s worker-free detector fetches
  // `index.html` with `cache: 'no-store'` precisely to learn what the SERVER
  // is serving; answering it from this cache would make it compare the app
  // against itself and never report a deploy.
  if (request.cache === 'no-store' || request.cache === 'reload') {
    return;
  }

  const isNavigation = request.mode === 'navigate';

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      if (isNavigation) {
        // NETWORK-FIRST for the document (review S-2).
        //
        // This used to be stale-while-revalidate like everything else, and
        // that was a measured cause of the owner's stranding, not a
        // theoretical one. `index.html` is the ONE served file whose bytes
        // change without its URL changing, and returning the cached copy
        // first meant a relaunch rendered the PREVIOUS deploy's document —
        // which names the previous deploy's hashed bundles — and only
        // refreshed the cache for next time. The technician who was told to
        // "close it completely and reopen" therefore got the old build back
        // on the first try, and the new one only on the second: exactly
        // "submitted, refused, redid the checklist, refused again".
        //
        // nginx serves it `no-cache` (so this costs a revalidation, not a
        // download) and the cached copy is still returned whenever the
        // network cannot answer — which is what keeps the app usable
        // offline.
        try {
          const fresh = await fetch(request);
          if (fresh.ok) void cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return (await cache.match(request)) ?? Response.error();
        }
      }

      // Content-addressed assets: a given URL's bytes never change, so
      // serving the cached copy instantly is both safe and what makes the
      // app usable offline after one prior online visit.
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => undefined);

      return cached ?? (await networkFetch) ?? Response.error();
    })(),
  );
});
