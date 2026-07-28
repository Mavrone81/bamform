import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UPDATE_POLL_INTERVAL_MS,
  __resetUpdateStateForTests,
  applyUpdate,
  beginCriticalWork,
  checkForUpdate,
  criticalWorkCount,
  isUpdatePending,
  onUpdatePendingChange,
  reportPossiblyOutdatedClient,
  startUpdateWatch,
} from './update';

/** A registration whose `update()` we can watch and whose worker states we
 * can drive, standing in for the browser's own service-worker lifecycle. */
function fakeRegistration() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    installing: null as object | null,
    waiting: null as { postMessage: ReturnType<typeof vi.fn>; state: string } | null,
    active: { state: 'activated' } as object | null,
    update: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    }),
    _fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

let reload: ReturnType<typeof vi.fn>;
let originalLocation: Location;
let visibility = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  __resetUpdateStateForTests();
  reload = vi.fn();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload },
    writable: true,
    configurable: true,
  });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    get: () => visibility,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe('critical-work gate', () => {
  it('counts overlapping sections and releases exactly once per token', () => {
    const endA = beginCriticalWork('submit');
    const endB = beginCriticalWork('signature-pad');
    expect(criticalWorkCount()).toBe(2);
    endA();
    endA(); // double-release must not underflow the count
    expect(criticalWorkCount()).toBe(1);
    endB();
    expect(criticalWorkCount()).toBe(0);
  });
});

describe('applying an update', () => {
  it('reloads immediately when no critical work is in progress', () => {
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('NEVER reloads while a submit is in flight or the signature pad is open', () => {
    const end = beginCriticalWork('signature-pad');
    applyUpdate();
    expect(reload).not.toHaveBeenCalled();
    expect(isUpdatePending()).toBe(true);
    end();
    // the moment the technician's work is finished, and not before
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once however many times it is applied', () => {
    applyUpdate();
    applyUpdate();
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('tells subscribers an update is waiting on them', () => {
    const seen: boolean[] = [];
    onUpdatePendingChange((p) => seen.push(p));
    const end = beginCriticalWork('submit');
    applyUpdate();
    expect(seen).toEqual([true]);
    end();
  });
});

describe('checkForUpdate', () => {
  it('is a no-op — never throws — when the browser has no service worker', async () => {
    vi.stubGlobal('navigator', {});
    await expect(checkForUpdate('test')).resolves.toBe(false);
  });

  it('asks the registration to re-fetch the worker and reports a new one', async () => {
    const reg = fakeRegistration();
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    expect(await checkForUpdate('test')).toBe(false);
    expect(reg.update).toHaveBeenCalledTimes(1);

    reg.installing = {};
    expect(await checkForUpdate('test')).toBe(true);
  });

  it('unsticks a worker parked in "waiting" instead of leaving the client stale', async () => {
    const reg = fakeRegistration();
    reg.waiting = { postMessage: vi.fn(), state: 'installed' };
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    expect(await checkForUpdate('test')).toBe(true);
    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('survives a registration that rejects (offline, blocked, torn down)', async () => {
    const reg = fakeRegistration();
    reg.update.mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    await expect(checkForUpdate('test')).resolves.toBe(false);
  });
});

describe('startUpdateWatch — the triggers a WebView actually delivers', () => {
  function armed() {
    const reg = fakeRegistration();
    vi.stubGlobal('navigator', {
      onLine: true,
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    const stop = startUpdateWatch();
    return { reg, stop };
  }

  it('checks once on start', async () => {
    const { reg, stop } = armed();
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('checks when the app becomes visible again — the Android resume path', async () => {
    const { reg, stop } = armed();
    await vi.advanceTimersByTimeAsync(0);
    reg.update.mockClear();

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).not.toHaveBeenCalled();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('checks when the connection comes back', async () => {
    const { reg, stop } = armed();
    await vi.advanceTimersByTimeAsync(0);
    reg.update.mockClear();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('polls while visible, and stops polling while hidden', async () => {
    const { reg, stop } = armed();
    await vi.advanceTimersByTimeAsync(0);
    reg.update.mockClear();

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);
    expect(reg.update).toHaveBeenCalledTimes(1);

    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS * 3);
    expect(reg.update).toHaveBeenCalledTimes(1); // no background polling
    stop();
  });

  it('stops listening once torn down', async () => {
    const { reg, stop } = armed();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    reg.update.mockClear();
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS * 2);
    expect(reg.update).not.toHaveBeenCalled();
  });
});

describe('no service worker at all (insecure http:// plant LAN)', () => {
  function pageLoadedWith(assetPath: string) {
    document.head.innerHTML = `<script src="${assetPath}"></script>`;
  }

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('spots a deploy by comparing the served index.html against the loaded assets', async () => {
    pageLoadedWith('/assets/index-OLD.js');
    vi.stubGlobal('navigator', {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '<script src="/assets/index-NEW.js"></script>',
      }),
    );

    expect(await checkForUpdate('test')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the served build is the one already loaded', async () => {
    pageLoadedWith('/assets/index-SAME.js');
    vi.stubGlobal('navigator', {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '<script src="/assets/index-SAME.js"></script>',
      }),
    );

    expect(await checkForUpdate('test')).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('makes no request at all when there is nothing to compare', async () => {
    vi.stubGlobal('navigator', {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await checkForUpdate('test')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays silent when the server is unreachable', async () => {
    pageLoadedWith('/assets/index-OLD.js');
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await checkForUpdate('test')).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('a reload storm can never happen', () => {
  it('stops auto-reloading and falls back to the banner after repeated update-reloads', () => {
    // Three update-reloads inside the window have already happened — e.g. a
    // deploy that is serving two different builds. A device that reload-loops
    // is worse than a device that is one version behind.
    __resetUpdateStateForTests();
    sessionStorage.setItem(
      'bamform.update.reloads',
      JSON.stringify([Date.now(), Date.now(), Date.now()]),
    );

    applyUpdate();
    expect(reload).not.toHaveBeenCalled();
    expect(isUpdatePending()).toBe(true);
    sessionStorage.clear();
  });

  it('records each update-reload so the next page load can see it', () => {
    sessionStorage.clear();
    applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('bamform.update.reloads') ?? '[]')).toHaveLength(1);
    sessionStorage.clear();
  });
});

describe('an outdated-client API rejection is a hard signal', () => {
  it('forces an update check', async () => {
    const reg = fakeRegistration();
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    reportPossiblyOutdatedClient(422);
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('ignores statuses that say nothing about the client being stale', async () => {
    const reg = fakeRegistration();
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    for (const status of [200, 401, 403, 404, 409, 500]) reportPossiblyOutdatedClient(status);
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).not.toHaveBeenCalled();
  });

  it('does not hammer the server when a stale client retries in a loop', async () => {
    const reg = fakeRegistration();
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(reg) },
    });
    reportPossiblyOutdatedClient(422);
    reportPossiblyOutdatedClient(400);
    reportPossiblyOutdatedClient(422);
    await vi.advanceTimersByTimeAsync(0);
    expect(reg.update).toHaveBeenCalledTimes(1);
  });
});
