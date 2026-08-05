import { useId, useRef, useState } from 'react';
import { logout } from '../auth';
import { getServices, getSyncUserId } from '../state/services';
import { pendingCountForUser } from '../offline/outbox';

export interface SignOutControlProps {
  /**
   * 'rail'  — compact control for the side rail's dark-chrome foot
   *           (`.nav-rail-foot`, NavShell.tsx), shown at >=768px.
   * 'menu'  — full-width block button on the Menu screen. Below 768px the
   *           rail is `display: none` (global.css), so this is the ONLY
   *           route to sign out; at >=768px `.menu-signout` (global.css)
   *           hides this copy so exactly one "Sign out" control is ever in
   *           the accessibility tree, mirroring how NavShell hides
   *           `.nav-tabs`/`.nav-rail` against each other per breakpoint.
   */
  variant: 'rail' | 'menu';
}

/**
 * THE sign-out control — button, unsent-work guard and warning dialog — in
 * one place. Extracted from `Menu` so the side rail's foot could offer the
 * same control without a second copy of the guard (the pattern
 * `ScheduleAdjustForm` set: one editor, mounted from both `MachineSchedule`
 * and `Planner`, because two copies of a guard eventually drift and stop
 * agreeing).
 *
 * The guard itself: signing out while this device holds unsent offline work
 * must never happen silently (SYS-6 — the operator must be TOLD). A faulted
 * IndexedDB used to make the original button just do nothing on tap, which
 * is indistinguishable from a missed tap; reading the count into `-1` and
 * showing the warning regardless is what keeps that failure mode from
 * masquerading as success. See `onSignOutTapped` below.
 *
 * Mounted twice at once on `/menu` at >=768px (rail foot + Menu screen).
 * `useId()` keeps each instance's dialog heading id unique so two mounted
 * `<dialog>`s never collide, independent of which one CSS currently hides.
 */
export function SignOutControl({ variant }: SignOutControlProps) {
  const [pendingCount, setPendingCount] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const warnDialogRef = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const headingId = `signout-warn-heading-${uid}`;

  async function doSignOut() {
    setSigningOut(true);
    try {
      // The outbox is deliberately NOT touched (SYS-6: clearing it on
      // sign-out would destroy unsent work). The rows stay keyed under
      // this user's server-returned id; no other account can see or drain
      // them, and they resume sending when this user signs back in.
      await logout();
      // App's token listener flips to the sign-in screen from here.
    } finally {
      setSigningOut(false);
    }
  }

  async function onSignOutTapped() {
    const userId = getSyncUserId();
    let count: number;
    try {
      count = userId ? await pendingCountForUser(getServices().db, userId) : 0;
    } catch {
      // This runs from a `void`ed click handler, so a faulted IndexedDB used
      // to reject into nothing — the Sign out button simply did nothing, with
      // no way to tell that from a missed tap. SYS-6 says they must be TOLD
      // when unsent work would be stranded; if the count cannot be read we do
      // not know whether any is, so we show the warning rather than signing
      // out silently. `-1` marks "unknown" for the dialog's copy.
      count = -1;
    }
    if (count !== 0) {
      // SYS-6: they must be TOLD their work has not been transmitted yet.
      setPendingCount(count);
      warnDialogRef.current?.showModal();
      return;
    }
    await doSignOut();
  }

  return (
    <>
      <button
        type="button"
        className={variant === 'rail' ? 'nav-rail-signout' : 'btn-block'}
        disabled={signingOut}
        onClick={() => void onSignOutTapped()}
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>

      <dialog ref={warnDialogRef} className="dialog" aria-labelledby={headingId}>
        <h2 id={headingId}>
          <span aria-hidden="true">⚠</span>{' '}
          {pendingCount < 0 ? (
            <>Unsent entries on this device could not be counted</>
          ) : (
            <>
              {pendingCount} unsent entr{pendingCount === 1 ? 'y' : 'ies'} on this device
            </>
          )}
        </h2>
        <p>
          {pendingCount < 0
            ? 'This device’s storage could not be read, so we cannot tell whether any of your work is still waiting to send.'
            : 'Work you recorded has not reached the server yet.'}{' '}
          Signing out keeps anything held safely stored on this device under your account — nobody
          else can see or send it — but it will NOT be transmitted until you sign back in on this
          device with a connection.
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => warnDialogRef.current?.close()}
          >
            Stay signed in
          </button>
          <button
            type="button"
            disabled={signingOut}
            onClick={() => {
              warnDialogRef.current?.close();
              void doSignOut();
            }}
          >
            Sign out anyway
          </button>
        </div>
      </dialog>
    </>
  );
}
