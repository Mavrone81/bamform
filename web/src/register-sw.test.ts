import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register-sw';
import { __resetUpdateStateForTests, beginCriticalWork } from './update';

function fakeServiceWorkerContainer(initialController: object | null) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    controller: initialController,
    register: vi.fn().mockResolvedValue(undefined),
    getRegistration: vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    }),
    removeEventListener: vi.fn(),
    // test helper, not part of the real API
    _fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

let originalReload: typeof window.location.reload;

beforeEach(() => {
  __resetUpdateStateForTests();
  originalReload = window.location.reload;
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload: vi.fn() },
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.reload = originalReload;
});

describe('registerServiceWorker', () => {
  it('does nothing in a browser without serviceWorker support', async () => {
    vi.stubGlobal('navigator', {});
    await expect(registerServiceWorker()).resolves.toBeUndefined();
  });

  it('registers the worker', async () => {
    const sw = fakeServiceWorkerContainer(null);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();
    expect(sw.register).toHaveBeenCalledWith('/sw.js');
  });

  it('does NOT reload on the first-ever controllerchange for a previously uncontrolled page', async () => {
    const sw = fakeServiceWorkerContainer(null); // no controller yet — first-ever visit
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();

    sw._fire('controllerchange');
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('DOES reload once when a NEW worker takes over an already-controlled page (O-12)', async () => {
    const sw = fakeServiceWorkerContainer({}); // already controlled — a real update scenario
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();

    sw._fire('controllerchange');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads more than once even if controllerchange fires repeatedly', async () => {
    const sw = fakeServiceWorkerContainer({});
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();

    sw._fire('controllerchange');
    sw._fire('controllerchange');
    sw._fire('controllerchange');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('does not throw if registration itself rejects', async () => {
    const sw = fakeServiceWorkerContainer(null);
    sw.register.mockRejectedValueOnce(new Error('registration disabled'));
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await expect(registerServiceWorker()).resolves.toBeUndefined();
  });

  /**
   * Slice 22: a page that was UNcontrolled at registration time used to
   * attach no `controllerchange` listener at all, so once it had been
   * claimed it could never notice a later deploy for the rest of its life —
   * and in the Android shell that life is "until the process is killed".
   * The first claim is still ignored (it is not an update); every claim
   * after it is a genuine one.
   */
  it('still notices an update that arrives AFTER the first-ever claim', async () => {
    const sw = fakeServiceWorkerContainer(null);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();

    sw._fire('controllerchange'); // first claim — not an update
    expect(window.location.reload).not.toHaveBeenCalled();

    sw._fire('controllerchange'); // a newer build took over mid-session
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('routes the update through the safety gate — no reload mid-signature', async () => {
    const sw = fakeServiceWorkerContainer({});
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();

    const end = beginCriticalWork('signature-pad');
    sw._fire('controllerchange');
    expect(window.location.reload).not.toHaveBeenCalled();
    end();
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('starts watching for updates once registered', async () => {
    const sw = fakeServiceWorkerContainer(null);
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();
    await Promise.resolve();
    await Promise.resolve();
    expect(sw.getRegistration).toHaveBeenCalled();
  });

  /**
   * An insecure `http://` origin — the plant-LAN deployment the Android
   * network-security config documents — cannot register a service worker at
   * all. It is still a single-page app that never navigates, so it can still
   * run all-shift on replaced JavaScript; the watch has a worker-free
   * fallback for exactly that, and must be armed to use it.
   */
  it('watches for updates EVEN IF registration failed (insecure origin)', async () => {
    const sw = fakeServiceWorkerContainer(null);
    sw.register.mockRejectedValueOnce(new Error('insecure origin'));
    vi.stubGlobal('navigator', { serviceWorker: sw });
    await registerServiceWorker();
    await Promise.resolve();
    await Promise.resolve();
    expect(sw.getRegistration).toHaveBeenCalled();
  });
});
