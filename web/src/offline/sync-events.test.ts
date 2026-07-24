import { describe, expect, it, vi } from 'vitest';
import { notifySynced, onSynced } from './sync-events';

describe('sync-events', () => {
  it('notifies every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    onSynced(a);
    onSynced(b);
    notifySynced();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onSynced(listener);
    unsubscribe();
    notifySynced();
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifying with no subscribers is a safe no-op', () => {
    expect(() => notifySynced()).not.toThrow();
  });
});
