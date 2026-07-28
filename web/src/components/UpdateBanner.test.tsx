import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { UpdateBanner } from './UpdateBanner';
import { __resetUpdateStateForTests, applyUpdate, beginCriticalWork } from '../update';

let reload: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  __resetUpdateStateForTests();
  reload = vi.fn();
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
});

describe('UpdateBanner', () => {
  it('shows nothing while the app is up to date', () => {
    render(<UpdateBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('appears when an update is being held back for the technician', () => {
    render(<UpdateBanner />);
    const end = beginCriticalWork('signature-pad');
    act(() => applyUpdate());

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('new version');
    // While a signature is on screen, "Reload now" would be a hard-constraint
    // violation with a friendly label on it. It must not be offered.
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    end();
  });

  /**
   * Review adjudication + S-3. The banner ALSO appears when the reload-storm
   * breaker has tripped — a state defined by `criticalWorkCount() === 0`,
   * where reloading is not merely safe but is the only thing that helps. With
   * no button, a user measured stuck there for 125 s never recovered. The
   * button is offered exactly when reloading is safe.
   */
  it('offers Reload now exactly when no work is in flight', () => {
    sessionStorage.setItem(
      'bamform.update.reloads',
      JSON.stringify([Date.now(), Date.now(), Date.now()]),
    );
    render(<UpdateBanner />);
    act(() => applyUpdate()); // storm branch: deferred with NO critical work

    expect(screen.getByRole('status')).toBeTruthy();
    const button = screen.getByRole('button', { name: /reload now/i });
    act(() => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    sessionStorage.clear();
  });

  it('withdraws the Reload button the moment work starts', () => {
    sessionStorage.setItem(
      'bamform.update.reloads',
      JSON.stringify([Date.now(), Date.now(), Date.now()]),
    );
    render(<UpdateBanner />);
    act(() => applyUpdate());
    expect(screen.queryByRole('button', { name: /reload now/i })).not.toBeNull();

    let end!: () => void;
    act(() => {
      end = beginCriticalWork('signature-pad');
    });
    expect(screen.queryByRole('button', { name: /reload now/i })).toBeNull();
    end();
    sessionStorage.clear();
  });

  it('can be dismissed without cancelling the update', () => {
    render(<UpdateBanner />);
    const end = beginCriticalWork('signature-pad');
    act(() => applyUpdate());

    act(() => screen.getByRole('button', { name: /dismiss/i }).click());
    expect(screen.queryByRole('status')).toBeNull();

    // Dismissing hides the notice; it does NOT strand the client on old code.
    end();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stops listening when unmounted', () => {
    const { unmount } = render(<UpdateBanner />);
    unmount();
    const end = beginCriticalWork('submit');
    expect(() => act(() => applyUpdate())).not.toThrow();
    end();
  });
});
