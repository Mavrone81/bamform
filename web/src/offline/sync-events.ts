/**
 * A tiny in-page event bus so exactly ONE `watchOnlineAndDrain` listener
 * needs to be registered for the whole app (in App.tsx) regardless of which
 * screen is currently mounted — a technician can be on RecordCapture when
 * connectivity returns, and the drain triggered by the `online` event must
 * still happen and still be reflected in that screen's sync-state display.
 * Screens subscribe here instead of each registering their own
 * `online`-event/drain wiring.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifySynced(): void {
  for (const listener of listeners) listener();
}

export function onSynced(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
