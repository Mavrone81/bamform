import { useEffect } from 'react';
import { beginCriticalWork } from '../update';

/**
 * Declares, for as long as [active] is true, that this screen is holding
 * work a reload would destroy — so the self-update mechanism must wait
 * (slice 22-SELFUPDATE; see `update.ts` for what qualifies and why).
 *
 * A hook rather than a call inside an event handler so that the section can
 * never be left open by an early return, a thrown render or an unmount: the
 * effect cleanup always closes it. `beginCriticalWork` tolerates being
 * released twice, which React StrictMode's double-invoked effects require.
 */
export function useCriticalWork(active: boolean, label: string): void {
  useEffect(() => {
    if (!active) return;
    return beginCriticalWork(label);
  }, [active, label]);
}
