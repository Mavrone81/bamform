import { setAccessToken, clearAccessToken, getAccessToken, isTokenStale } from './token-store';
import { API_BASE } from '../api/config';
import type { components } from '../api/generated/openapi-types';

type AuthResult = components['schemas']['AuthResult'];

/**
 * Login/refresh/logout live outside `SyncTransport` — they are not part of
 * the offline outbox contract (nothing about signing in is ever queued
 * offline; a technician must be online and authenticated before the outbox
 * has anything to drain). Non-negotiable #10: the refresh token is an
 * HttpOnly cookie the browser attaches automatically via
 * `credentials: 'include'` — this module never reads or writes it, and the
 * access token it DOES receive is handed straight to token-store (memory
 * only), never persisted here either.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status}`);
  }
  const body = (await res.json()) as AuthResult;
  setAccessToken(body.accessToken, body.expiresIn);
  return body;
}

/** Rotates the refresh cookie and issues a new access token. Relies entirely
 * on the HttpOnly cookie the browser sends automatically — no token is read
 * from JS to make this call. */
export async function refresh(): Promise<AuthResult | null> {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    clearAccessToken();
    return null;
  }
  const body = (await res.json()) as AuthResult;
  setAccessToken(body.accessToken, body.expiresIn);
  return body;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {
    // Best-effort: even if the request fails, the local session must end.
  });
  clearAccessToken();
}

/** Ensures a usable access token exists before a caller makes an
 * authenticated request, refreshing proactively when the current one is
 * within its expiry window rather than waiting for a 401. */
export async function ensureFreshToken(): Promise<string | null> {
  if (getAccessToken() && !isTokenStale()) return getAccessToken();
  const result = await refresh();
  return result?.accessToken ?? null;
}

/**
 * PR-API-07: re-authenticates immediately before a signing action
 * (verify/approve). Called from the Record Review screen only after
 * `verifyJob` comes back 403 `step-up-required` — never speculatively. The
 * password is sent once, straight through to the server, and is never
 * stored anywhere on this device (non-negotiable #10 applies here too,
 * even though this value is not the access token): the caller passes it in,
 * this function does not retain a reference to it after the fetch resolves.
 */
export async function stepUp(password: string): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE}/auth/step-up`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    // Mirrors `login`'s PR-007 convention: the client never surfaces WHY
    // (wrong password vs. rate-limited) — that judgement stays server-side.
    throw new Error(`step-up failed: ${res.status}`);
  }
}
