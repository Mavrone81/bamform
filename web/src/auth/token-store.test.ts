import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setAccessToken,
  clearAccessToken,
  getAccessToken,
  isTokenStale,
  onTokenChange,
  assertTokenNeverPersisted,
  scanStorageForLeak,
  _resetForTests,
} from './token-store';

beforeEach(() => {
  _resetForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('token-store — non-negotiable #10: memory only, never persisted', () => {
  it('returns null before any token is set', () => {
    expect(getAccessToken()).toBeNull();
    expect(isTokenStale()).toBe(true);
  });

  it('holds the token in memory and returns it', () => {
    setAccessToken('abc.def.ghi', 900);
    expect(getAccessToken()).toBe('abc.def.ghi');
  });

  it('clears the token', () => {
    setAccessToken('abc.def.ghi', 900);
    clearAccessToken();
    expect(getAccessToken()).toBeNull();
  });

  it('is never written to localStorage or sessionStorage as a side effect of normal use', () => {
    setAccessToken('super-secret-token-value', 900);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(assertTokenNeverPersisted()).toBeUndefined(); // does not throw
  });

  it('assertTokenNeverPersisted throws if something DID leak the token into localStorage', () => {
    setAccessToken('super-secret-token-value', 900);
    window.localStorage.setItem('oops', 'super-secret-token-value');
    expect(() => assertTokenNeverPersisted()).toThrow(/localStorage/);
  });

  it('assertTokenNeverPersisted throws if something DID leak the token into sessionStorage', () => {
    setAccessToken('another-secret-value', 900);
    window.sessionStorage.setItem('oops', 'another-secret-value');
    expect(() => assertTokenNeverPersisted()).toThrow(/sessionStorage/);
  });

  it('reports stale once within 30s of the expiry it was given', () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    setAccessToken('t', 60); // expires in 60s
    expect(isTokenStale()).toBe(false);
    vi.setSystemTime(start + 31_000); // 31s later — inside the 30s pre-expiry window
    expect(isTokenStale()).toBe(true);
  });

  it('does not throw scanning storage that contains data when no token is currently set', () => {
    // state is null (no setAccessToken call yet) — nothing to compare against.
    window.localStorage.setItem('unrelated', 'some-value-that-looks-like-a-token');
    expect(() => assertTokenNeverPersisted()).not.toThrow();
  });

  it('scanStorageForLeak tolerates a Storage implementation whose key(i) returns null', () => {
    const oddStorage: Storage = {
      length: 1,
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    setAccessToken('t', 900);
    expect(() => scanStorageForLeak(oddStorage, 'oddStorage')).not.toThrow();
  });

  it('notifies listeners on set and clear, and unsubscribe stops further notifications', () => {
    const seen: Array<string | null> = [];
    const unsubscribe = onTokenChange((s) => seen.push(s?.accessToken ?? null));
    setAccessToken('x', 900);
    clearAccessToken();
    unsubscribe();
    setAccessToken('y', 900);
    expect(seen).toEqual(['x', null]);
  });
});
