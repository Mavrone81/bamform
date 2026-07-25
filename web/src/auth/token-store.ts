/**
 * Non-negotiable #10 (BUILD_HANDOFF §4): the access token lives in memory
 * ONLY. It is never written to `localStorage`, `sessionStorage`, IndexedDB,
 * or any other persistent store — a page reload always starts from zero and
 * must silently refresh via the HttpOnly `bf_refresh` cookie the server set
 * on login (api/openapi.yaml `/auth/login`, `/auth/refresh`). The refresh
 * token itself is never visible to JavaScript at all; the browser attaches
 * it automatically because the cookie is HttpOnly + Secure + SameSite=Strict.
 *
 * This module is deliberately the ONLY place an access token is held. Every
 * other module that needs it calls `getAccessToken()` rather than caching
 * its own copy, so there is exactly one code path to audit for the
 * never-localStorage rule (S-16/S-29 territory).
 */

export interface TokenState {
  accessToken: string;
  /** Epoch ms this token is expected to expire — used to trigger a
   * proactive refresh slightly before the server would reject it. */
  expiresAt: number;
}

let state: TokenState | null = null;
const listeners = new Set<(state: TokenState | null) => void>();

export function setAccessToken(accessToken: string, expiresInSeconds: number): void {
  state = { accessToken, expiresAt: Date.now() + expiresInSeconds * 1000 };
  for (const listener of listeners) listener(state);
}

export function clearAccessToken(): void {
  state = null;
  for (const listener of listeners) listener(state);
}

export function getAccessToken(): string | null {
  return state?.accessToken ?? null;
}

/** True once we're within 30s of expected expiry — callers use this to
 * refresh proactively instead of waiting for a 401. */
export function isTokenStale(): boolean {
  if (!state) return true;
  return Date.now() >= state.expiresAt - 30_000;
}

export function onTokenChange(listener: (state: TokenState | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: guarantees no state leaks between test cases. */
export function _resetForTests(): void {
  state = null;
  listeners.clear();
}

/**
 * Defence-in-depth guard, not the mechanism itself (the mechanism is simply
 * "never call localStorage/sessionStorage from this module"). This exists so
 * a unit test can assert the property continuously, not just review it once
 * — if a future edit to this file starts persisting the token, this
 * function (and its test) breaks immediately.
 */
export function scanStorageForLeak(storage: Storage, storageName: string): void {
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const value = key ? storage.getItem(key) : null;
    if (value && state && value.includes(state.accessToken)) {
      throw new Error(`Access token leaked into ${storageName} — non-negotiable #10 violated`);
    }
  }
}

export function assertTokenNeverPersisted(): void {
  // This module targets a browser (Vite SPA / PWA) — `window` always exists
  // at runtime and in every test environment this suite runs under (jsdom).
  scanStorageForLeak(window.localStorage, 'localStorage');
  scanStorageForLeak(window.sessionStorage, 'sessionStorage');
}
