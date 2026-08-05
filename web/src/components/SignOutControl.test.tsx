/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * SignOutControl is the ONE guard against SYS-6's failure mode: signing out
 * while this device holds unsent offline work, silently. It is mounted in
 * two places (NavShell.tsx's rail foot, Menu.tsx) and both must behave
 * identically — the whole point of the extraction (see the file's own
 * doc comment) is that there is exactly one guard to get right, not two
 * that can drift apart. Every guard test below runs against BOTH variants.
 *
 * Module seams are mocked the same way `JobList.test.tsx` mocks
 * `state/services` — mutable module-scope `let`s the factory closures read
 * lazily, so each test can steer the outbox read and the sign-out call
 * independently without touching real IndexedDB.
 */

let pendingCountImpl: () => Promise<number> = () => Promise.resolve(0);
let syncUserId: string | null = 'user-1';
let logoutImpl: () => Promise<void> = () => Promise.resolve();
const logoutCalls: number[] = [];

vi.mock('../auth', () => ({
  logout: () => {
    logoutCalls.push(Date.now());
    return logoutImpl();
  },
}));

vi.mock('../state/services', () => ({
  getServices: () => ({ db: {}, transport: {} }),
  getSyncUserId: () => syncUserId,
}));

vi.mock('../offline/outbox', () => ({
  pendingCountForUser: () => pendingCountImpl(),
}));

// Imported after the mocks above so it binds to the mocked seams.
import { SignOutControl } from './SignOutControl';

// jsdom 29 parses <dialog> but does not implement the modal methods
// (neither exists yet — confirmed by running this suite without the
// polyfill: "showModal is not a function"). `open` is what
// `@testing-library/dom`'s role/visibility computation keys off for a
// `<dialog>`, so toggling it is enough to make `getByRole('dialog')` behave
// exactly as the real DOM does once `showModal()`/`close()` are called.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

beforeEach(() => {
  pendingCountImpl = () => Promise.resolve(0);
  syncUserId = 'user-1';
  logoutImpl = () => Promise.resolve();
  logoutCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe.each(['rail', 'menu'] as const)('SignOutControl — variant=%s', (variant) => {
  it('renders a "Sign out" button', () => {
    render(<SignOutControl variant={variant} />);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('signs out directly, with no dialog, when nothing is pending', async () => {
    pendingCountImpl = () => Promise.resolve(0);
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(logoutCalls).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('warns instead of signing out when unsent work is pending, and only signs out once confirmed', async () => {
    pendingCountImpl = () => Promise.resolve(3);
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('3 unsent entries on this device');
    expect(dialog).toHaveTextContent(/NOT be transmitted/);
    expect(logoutCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(logoutCalls).toHaveLength(1));
  });

  it('uses singular copy for exactly one pending entry', async () => {
    pendingCountImpl = () => Promise.resolve(1);
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('1 unsent entry on this device');
  });

  it('"Stay signed in" closes the warning and never signs out', async () => {
    pendingCountImpl = () => Promise.resolve(2);
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(logoutCalls).toHaveLength(0);
  });

  // The count-UNREADABLE path — SYS-6's core guard, and per the brief the
  // one most likely to be dropped in a refactor. A faulted IndexedDB used
  // to make the original button silently do nothing (indistinguishable from
  // a missed tap); this asserts the warning fires instead of a silent
  // sign-out, in BOTH mount points.
  it('warns "could not be counted" when the pending count cannot be read, and does not sign out until confirmed', async () => {
    pendingCountImpl = () => Promise.reject(new Error('idb blocked'));
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Unsent entries on this device could not be counted');
    expect(dialog).toHaveTextContent(/storage could not be read/);
    expect(logoutCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(logoutCalls).toHaveLength(1));
  });

  it('the count-unreadable warning can also be dismissed without signing out', async () => {
    pendingCountImpl = () => Promise.reject(new Error('idb blocked'));
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(logoutCalls).toHaveLength(0);
  });

  it('signs out directly without reading the outbox when there is no signed-in user id', async () => {
    syncUserId = null;
    const countSpy = vi.fn(() => Promise.resolve(5));
    pendingCountImpl = countSpy;
    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(logoutCalls).toHaveLength(1));
    expect(countSpy).not.toHaveBeenCalled();
  });

  it('disables the button and shows "Signing out…" while sign-out is in flight, then re-arms', async () => {
    pendingCountImpl = () => Promise.resolve(0);
    let resolveLogout: () => void = () => {};
    logoutImpl = () => new Promise<void>((resolve) => (resolveLogout = resolve));

    render(<SignOutControl variant={variant} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    const busyButton = await screen.findByRole('button', { name: 'Signing out…' });
    expect(busyButton).toBeDisabled();

    resolveLogout();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled());
  });
});

describe('SignOutControl — per-context styling (task: native to each context, not one shape forced into both)', () => {
  it('the rail variant gets the compact rail class', () => {
    render(<SignOutControl variant="rail" />);
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveClass('nav-rail-signout');
  });

  it('the menu variant gets the full-width block class', () => {
    render(<SignOutControl variant="menu" />);
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveClass('btn-block');
  });
});

describe('SignOutControl — both mount points at once (>=768px: rail foot + Menu screen)', () => {
  it('keeps each dialog heading id unique so aria-labelledby never collides', async () => {
    pendingCountImpl = () => Promise.resolve(4);
    render(
      <>
        <SignOutControl variant="rail" />
        <SignOutControl variant="menu" />
      </>,
    );
    const buttons = screen.getAllByRole('button', { name: 'Sign out' });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(2);

    const headingIds = dialogs.map((d) => d.getAttribute('aria-labelledby'));
    expect(headingIds[0]).toBeTruthy();
    expect(headingIds[1]).toBeTruthy();
    expect(headingIds[0]).not.toEqual(headingIds[1]);
  });
});
