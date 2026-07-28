/**
 * Slice 22-SELFUPDATE — keeping a device off stale code.
 *
 * ## What was actually wrong (measured, 2026-07-28 — see the slice report)
 *
 * `sw.ts` already called `skipWaiting()`/`clients.claim()` and
 * `register-sw.ts` already reloaded on `controllerchange`. That machinery is
 * correct and it was never the problem. The problem is that **nothing ever
 * triggered it**: a service worker is only re-fetched and byte-compared on a
 * *document navigation* (or on the browser's own ~24h check), and BamForm
 * performs almost none.
 *
 *  - In a browser tab left open on the SPA (the router only ever calls
 *    `history.pushState`) the client stayed on the old build for the full
 *    3-minute observation with `installing`/`waiting` both null the whole
 *    time — no check was ever made.
 *  - In the Android shell it is worse. `MainActivity.onCreate` is the only
 *    thing that calls `loadUrl`, and tapping the launcher icon on a task
 *    that is still alive brings the activity to the front **without**
 *    re-creating it. Measured on the emulator: two full background/resume
 *    cycles left the WebView on build A. Only `am force-stop` (which no
 *    technician performs) produced a navigation, and that recovered on the
 *    first try. That is precisely "the owner relaunched the app and it was
 *    still stale".
 *
 * Neither the HTTP cache nor Cache Storage held the stale copy — Cache
 * Storage was measurably EMPTY in both stale states. It was the service
 * worker lifecycle, for want of an `update()` call.
 *
 * ## What this module does
 *
 * Calls `registration.update()` on the events that a WebView genuinely
 * delivers, and turns "a new worker took control" into a reload that can
 * never land on top of a technician's work.
 *
 * The trigger set is chosen from measurement, not from the usual advice:
 * `window` `focus`/`blur` never fire in the Android WebView and
 * `document.hasFocus()` is permanently `false` there, so a focus-based
 * check — the common recipe — would have fixed the browser and left the
 * tablets exactly as broken as they are today. `visibilitychange` DOES fire
 * on the resume path (measured: `vis:hidden` then `vis:visible` across a
 * HOME/relaunch cycle), so that is the Android-carrying trigger, and it is
 * why this slice needs no Kotlin change to update the app.
 */

/** Belt-and-braces poll while the app is on screen. `/sw.js` is ~700 bytes
 * and served `no-store`, so this costs a device essentially nothing, and it
 * closes the one gap `visibilitychange` cannot: a tablet left awake on the
 * job list all shift while a deploy goes out. Never runs while hidden — a
 * backgrounded WebView keeps its timers running (measured: 10 ticks over 10
 * background seconds), so an ungated interval would poll from the pocket. */
export const UPDATE_POLL_INTERVAL_MS = 5 * 60_000;

/** An outdated-client signal from the API is rate-limited to this: a stale
 * client that retries in a loop must not turn into a request amplifier. */
const OUTDATED_SIGNAL_THROTTLE_MS = 30_000;

/**
 * Statuses that can mean "this client does not know what the server now
 * requires". Slice 18 made `drawnSignature` required on submit and a client
 * built before it existed got a 422 it could not have satisfied.
 *
 * Deliberately NOT a check for particular field names: the next breaking
 * change will name a different field, and a client too old to know about a
 * field is by definition too old to recognise its name. The check that
 * always works is the mechanical one this triggers — ask the server whether
 * a different `sw.js` exists. If one does, this client IS stale, whatever
 * the rejection said; if one does not, the rejection was genuine and the
 * user gets the honest message the app already shows.
 */
const OUTDATED_CLIENT_STATUSES = new Set([400, 422]);

type PendingListener = (pending: boolean) => void;

let criticalSections = 0;
let updateDeferred = false;
let reloadIssued = false;
let lastOutdatedSignalAt = 0;
const pendingListeners = new Set<PendingListener>();

/** Test seam only — module state is a singleton by design (there is one
 * document and one registration), so the suite needs a way to rewind it. */
export function __resetUpdateStateForTests(): void {
  criticalSections = 0;
  updateDeferred = false;
  reloadIssued = false;
  lastOutdatedSignalAt = 0;
  pendingListeners.clear();
  try {
    sessionStorage.removeItem(RELOAD_LOG_KEY);
  } catch {
    // no session storage in this environment — nothing to rewind
  }
}

// ---------------------------------------------------------------------------
// The gate: work that a reload must never interrupt
// ---------------------------------------------------------------------------

/**
 * Marks a span during which this app MUST NOT reload itself. Returns the
 * release; releasing twice is harmless (React effect cleanups run more than
 * once under StrictMode).
 *
 * The two spans that matter are non-negotiable, and both hold state that
 * exists ONLY in memory:
 *  - the signature pad being open through to the submit resolving — the
 *    drawn PNG is deliberately never written to IndexedDB (it is personal
 *    data and `sync-engine.submitJob` says so), so a reload in that window
 *    destroys a signature the technician has already given;
 *  - an attachment upload in flight — a reload aborts the XHR.
 * Checklist entries are NOT in this set and do not need to be: every item
 * change is written to the outbox by `appendJobMutation` as it happens, so
 * a reload between taps costs a scroll position and nothing else.
 */
export function beginCriticalWork(_label: string): () => void {
  criticalSections += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    criticalSections -= 1;
    // The moment the technician's work is finished — and not before — a
    // deferred update takes effect. Nothing happens if none was waiting.
    if (criticalSections === 0 && updateDeferred) applyUpdate();
  };
}

export function criticalWorkCount(): number {
  return criticalSections;
}

/** True when a newer build has taken control but the reload is being held
 * back for the technician. Drives the "reload to finish updating" banner. */
export function isUpdatePending(): boolean {
  return updateDeferred;
}

export function onUpdatePendingChange(listener: PendingListener): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/**
 * A newer build is in control of this page — run it. Reloads immediately
 * when that is safe, and otherwise defers until the last critical section
 * closes (which is what re-enters this function).
 *
 * Deferring rather than cancelling is the point: the update always lands,
 * the technician just decides when by finishing what they were doing.
 */
export function applyUpdate(): void {
  if (reloadIssued) return;
  if (criticalSections > 0 || isReloadStorm()) {
    if (!updateDeferred) {
      updateDeferred = true;
      for (const l of pendingListeners) l(true);
    }
    return;
  }
  reloadIssued = true;
  noteUpdateReload();
  window.location.reload();
}

/**
 * The circuit breaker. `reloadIssued` only bounds reloads within ONE page
 * load, and an update reload starts a new one — so if the origin were ever
 * serving two different builds at once (a half-finished deploy, two
 * containers behind one address), every fresh page would see "a different
 * `sw.js`" and reload again, forever. A tablet stuck in a reload loop is a
 * worse outcome than a tablet one version behind: it is unusable, and it
 * takes the technician's screen with it.
 *
 * Past the budget this stops reloading automatically and shows the banner
 * instead — the update still lands, on the next ordinary navigation or when
 * the operator acts, and the loop cannot happen. `sessionStorage` because
 * the state must outlive a reload but must NOT outlive the app: a new
 * session starts with a clean budget.
 */
const RELOAD_LOG_KEY = 'bamform.update.reloads';
const RELOAD_STORM_WINDOW_MS = 120_000;
const MAX_RELOADS_PER_WINDOW = 3;

function recentUpdateReloads(): number[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(RELOAD_LOG_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - RELOAD_STORM_WINDOW_MS;
    return raw.filter((t): t is number => typeof t === 'number' && t > cutoff);
  } catch {
    // sessionStorage can throw outright (Safari private mode, storage
    // disabled by policy). Losing the budget must not lose the update.
    return [];
  }
}

function isReloadStorm(): boolean {
  return recentUpdateReloads().length >= MAX_RELOADS_PER_WINDOW;
}

function noteUpdateReload(): void {
  try {
    sessionStorage.setItem(RELOAD_LOG_KEY, JSON.stringify([...recentUpdateReloads(), Date.now()]));
  } catch {
    // See above — best-effort accounting, never load-bearing for correctness.
  }
}

// ---------------------------------------------------------------------------
// The triggers
// ---------------------------------------------------------------------------

/**
 * Ask the browser to re-fetch `/sw.js` and byte-compare it. Resolves true
 * when the server is serving a different build than this client is running
 * — which is exactly the version comparison this slice needs, with no new
 * endpoint, no new static asset and no new API contract to keep in step.
 *
 * Never throws: it runs on a timer, on resume and on the API error path,
 * and an offline device (the normal state on a plant floor) must not see a
 * rejection here turn into anything at all.
 */
export async function checkForUpdate(_reason: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return deployedAssetsDiffer();
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return deployedAssetsDiffer();
    await registration.update();
    if (registration.waiting) {
      // A worker parked in `waiting` is a client that will stay stale
      // forever from its own point of view. `sw.ts` calls `skipWaiting()` in
      // `install`, so this should be unreachable — but "should be" is what
      // shipped the bug this slice exists to fix, and a worker whose install
      // handler threw would sit here indefinitely. Push it through.
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return true;
    }
    return Boolean(registration.installing);
  } catch {
    // Offline, blocked by policy, or the registration was torn down.
    return false;
  }
}

/**
 * The no-service-worker path, and the one place this slice is NOT relying on
 * the service worker at all.
 *
 * `android/.../network_security_config.xml` documents, correctly, that a
 * plant-internal `http://` deployment gets no service worker: an insecure
 * origin is not a secure context, so `register()` fails and every mechanism
 * above it — `registration.update()`, `controllerchange`, the whole
 * lifecycle — is simply absent. Such a client has no Cache Storage either,
 * so it is not stale in the usual sense; but the SPA still never performs a
 * document navigation, so the JavaScript loaded at sign-in keeps running
 * against a server that may have moved on. Same stranding, different
 * plumbing, and it deserved better than being left out.
 *
 * The comparison is exact and needs nothing new deployed: `index.html` is
 * served `no-cache` and names the hashed asset files of the CURRENT build,
 * so if it names a file this document did not load, this document is old.
 * Bails out silently on anything unexpected — an offline device must not be
 * told it is out of date, and a page with no hashed assets (the dev server,
 * the unit-test DOM) has nothing to say.
 */
async function deployedAssetsDiffer(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const loaded = new Set(
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')]
      .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
      .map((href) => {
        try {
          return new URL(href, window.location.href).pathname;
        } catch {
          return '';
        }
      })
      .filter((path) => path.startsWith('/assets/')),
  );
  if (loaded.size === 0) return false;

  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return false;
    const html = await res.text();
    const deployed = [...html.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]);
    if (deployed.length === 0) return false;
    if (deployed.every((path) => loaded.has(path))) return false;
  } catch {
    return false; // offline, or the origin is unreachable
  }

  // There is no worker to take control and no `controllerchange` coming —
  // this IS the whole detection, so it applies the update itself.
  applyUpdate();
  return true;
}

/**
 * Wires every trigger that can reach a device in the field and returns the
 * teardown. See the module doc for why the set is what it is.
 */
export function startUpdateWatch(): () => void {
  let stopped = false;
  const check = (reason: string) => {
    if (!stopped) void checkForUpdate(reason);
  };

  const onVisibility = () => {
    // The Android resume path, and a browser tab being switched back to.
    if (document.visibilityState === 'visible') check('visible');
  };
  const onOnline = () => check('online');

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') check('poll');
  }, UPDATE_POLL_INTERVAL_MS);

  check('start');

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    clearInterval(timer);
  };
}

/**
 * The hard signal (brief §1): the server just refused a request in a way
 * that a client built against an older contract would be refused. Force the
 * check rather than only apologising.
 *
 * Called from `authorizedFetch`, the single seam every authenticated request
 * already passes through, so a screen added in a future slice inherits it.
 */
export function reportPossiblyOutdatedClient(status: number): void {
  if (!OUTDATED_CLIENT_STATUSES.has(status)) return;
  const now = Date.now();
  if (now - lastOutdatedSignalAt < OUTDATED_SIGNAL_THROTTLE_MS) return;
  lastOutdatedSignalAt = now;
  void checkForUpdate(`api-${status}`);
}
