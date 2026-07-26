import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeRecoveryCodes,
  getPendingRecoveryCodes,
  onPendingRecoveryCodesChange,
  setPendingRecoveryCodes,
  _resetForTests,
} from './recovery-codes-store';

const CODES = Array.from({ length: 10 }, (_, i) => `CODE-${i}`);

beforeEach(() => {
  _resetForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('U-RECOV-01: the one-time recovery codes latch', () => {
  it('holds the codes until they are acknowledged', () => {
    expect(getPendingRecoveryCodes()).toBeNull();
    setPendingRecoveryCodes(CODES);
    expect(getPendingRecoveryCodes()).toEqual(CODES);
    acknowledgeRecoveryCodes();
    expect(getPendingRecoveryCodes()).toBeNull();
  });

  it('notifies subscribers on set and on acknowledgement, but not on a repeat acknowledgement', () => {
    const listener = vi.fn();
    const unsubscribe = onPendingRecoveryCodesChange(listener);

    setPendingRecoveryCodes(CODES);
    expect(listener).toHaveBeenCalledWith(CODES);

    acknowledgeRecoveryCodes();
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(listener).toHaveBeenCalledTimes(2);

    acknowledgeRecoveryCodes();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPendingRecoveryCodes(CODES);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('persists nothing — the codes exist in memory and on the screen, nowhere else', () => {
    setPendingRecoveryCodes(CODES);
    const persisted = [
      ...Object.values(window.localStorage),
      ...Object.values(window.sessionStorage),
    ].join('|');
    for (const code of CODES) expect(persisted).not.toContain(code);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
