import { setAccessToken, clearAccessToken, getAccessToken, isTokenStale } from './token-store';
import type { components } from '../api/generated/openapi-types';

type AuthResult = components['schemas']['AuthResult'];

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

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
