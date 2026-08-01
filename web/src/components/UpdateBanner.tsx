import { useEffect, useState } from 'react';
import {
  applyUpdateNow,
  isUpdatePending,
  isUpdateSafeToApplyNow,
  onUpdatePendingChange,
  onUpdateSafetyChange,
} from '../update';

/**
 * Slice 22-SELFUPDATE §4. The app updates itself silently: a newer build
 * takes control, `applyUpdate()` reloads, and the technician sees nothing —
 * which is the correct experience for something that is nobody's job to
 * think about.
 *
 * This banner covers the two cases where silence would be wrong:
 *
 *  - the update landed while the signature pad was open, a submit was in
 *    flight or a photo was uploading, so the reload is being held back
 *    (`update.ts` — those three spans hold state that exists only in
 *    memory). It gets out of the way the moment that work finishes, because
 *    finishing the work is what releases the reload.
 *  - the reload-storm breaker has tripped, in which case **nothing is in
 *    flight at all** and the app has simply stopped reloading itself.
 *
 * ## Why there IS a Reload button, and why it is conditional
 *
 * The first version had no button, arguing that the banner only ever appears
 * when reloading would destroy a drawn signature. Review showed that premise
 * to be false — the storm branch is *defined* by `criticalWorkCount() === 0`
 * — and measured a user parked in that state for 125 s with no way out, on a
 * permanently stale client, where one reload would have fixed everything.
 *
 * So the button is offered exactly when reloading is safe, which is also
 * exactly when `applyUpdate()` would reload of its own accord. While a
 * signature is on screen it is withdrawn: a "Reload now" that destroys a
 * drawn signature would be a hard-constraint violation with a friendly label
 * on it.
 *
 * Dismiss hides the notice; it does not cancel the update, which still
 * applies as soon as it is safe.
 */
export function UpdateBanner() {
  const [pending, setPending] = useState(isUpdatePending);
  const [safe, setSafe] = useState(isUpdateSafeToApplyNow);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => onUpdatePendingChange(setPending), []);
  useEffect(() => onUpdateSafetyChange(setSafe), []);

  if (!pending || dismissed) return null;

  return (
    <p className="banner update-banner" data-tone="info" role="status">
      <span aria-hidden="true">↻</span>
      <span>
        A new version of BamForm is ready.{' '}
        {safe
          ? 'Reload to finish updating — your entries are safe.'
          : 'It will finish updating as soon as that is safe — your entries are safe either way.'}
      </span>
      {safe && (
        <button
          type="button"
          className="btn-quiet update-banner-action"
          onClick={() => applyUpdateNow()}
        >
          Reload now
        </button>
      )}
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
