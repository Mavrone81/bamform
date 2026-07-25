import type { JobSyncState } from '../offline/sync-engine';

/**
 * PR-066 / A-05: sync state is shown as text AND an icon, never colour
 * alone — shop-floor sunlight and gloves defeat colour-only signals. The
 * icon glyphs below are chosen to be distinguishable by shape alone even in
 * greyscale/low-contrast viewing conditions (a circle outline, an arrows
 * loop, a triangle, a check), independent of the tone colour.
 */
const LABELS: Record<
  JobSyncState,
  { text: string; icon: string; tone: 'neutral' | 'attention' | 'good' | 'bad' }
> = {
  'held-on-device': { text: 'Held on device', icon: '◯', tone: 'neutral' }, // ◯
  sending: { text: 'Sending…', icon: '↻', tone: 'attention' }, // ↻
  conflict: { text: 'Conflict — needs your input', icon: '⚠', tone: 'bad' }, // ⚠
  'received-by-server': { text: 'Received by server', icon: '✓', tone: 'good' }, // ✓
};

export function SyncStatusChip({ state }: { state: JobSyncState }) {
  const { text, icon, tone } = LABELS[state];
  return (
    <span className="status-chip" data-tone={tone} role="status">
      <span aria-hidden="true">{icon}</span>
      {text}
    </span>
  );
}
