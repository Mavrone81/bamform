import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register-sw';

function fakeServiceWorkerContainer(initialController: object | null) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    controller: initialController,
    register: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    }),
    // test helper, not part of the real API
    _fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

let originalReload: typeof window.location.reload;

beforeEach(() => {
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
});
