import type { Response } from 'express';
import { RateLimitedException } from './problems';
import type { IssuedRefreshToken } from './refresh/refresh-token.service';

export const REFRESH_COOKIE_NAME = 'bf_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * SEC §10.3: `bf_refresh` — `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`
 * (PR-085). Extracted from `auth.controller.ts` in slice 13-MFA so
 * `MfaController` sets an IDENTICAL cookie when `/auth/mfa/verify`,
 * `/auth/mfa/recovery` or `/auth/mfa/enrol/confirm` completes a login — a
 * second copy of these attributes is exactly the sort of drift S-29 exists to
 * catch, so there is only one copy.
 */
export function setRefreshCookie(res: Response, issued: IssuedRefreshToken): void {
  res.cookie(REFRESH_COOKIE_NAME, issued.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    expires: issued.expiresAt,
  });
}

export function applyRetryAfter(res: Response, error: unknown): void {
  if (error instanceof RateLimitedException) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
}
