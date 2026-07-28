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

  it('appears only when an update is being held back for the technician', () => {
    render(<UpdateBanner />);
    const end = beginCriticalWork('signature-pad');
    act(() => applyUpdate());

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('new version');
    // It must not offer to reload NOW: the only reason it is on screen is
    // that reloading now would destroy work in progress.
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
    end();
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
