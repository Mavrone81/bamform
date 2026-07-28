import { useEffect, useState } from 'react';
import { isUpdatePending, onUpdatePendingChange } from '../update';

/**
 * Slice 22-SELFUPDATE §4. The app updates itself silently: a newer build
 * takes control, `applyUpdate()` reloads, and the technician sees nothing —
 * which is the correct experience for something that is nobody's job to
 * think about.
 *
 * This banner is the one case where silence would be wrong: the update
 * landed while the signature pad was open, a submit was in flight or a photo
 * was uploading, so the reload is being held back (`update.ts` — those three
 * spans hold state that exists only in memory). It says so, and gets out of
 * the way the moment that work finishes, because finishing the work is what
 * releases the reload.
 *
 * There is deliberately NO "reload now" button. The only reason this
 * component is on screen at all is that reloading right now would destroy a
 * signature the technician has already drawn or abort a submit mid-flight —
 * a button that did that would be a hard-constraint violation with a
 * friendly label on it. Dismiss hides the notice; it does not cancel the
 * update, which still applies as soon as it is safe.
 */
export function UpdateBanner() {
  const [pending, setPending] = useState(isUpdatePending);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => onUpdatePendingChange(setPending), []);

  if (!pending || dismissed) return null;

  return (
    <p className="banner update-banner" data-tone="info" role="status">
      <span aria-hidden="true">↻</span>
      <span>
        A new version of BamForm is ready. It will finish updating as soon as that is safe — your
        entries are safe either way.
      </span>
      <button
        type="button"
        className="btn-quiet update-banner-dismiss"
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </p>
  );
}
