import { setAccessToken, clearAccessToken, getAccessToken, isTokenStale } from './token-store';
import {
  clearChallenge,
  getChallengeToken,
  isChallengeExpired,
  setChallenge,
} from './challenge-store';
import { clearCurrentUser, getCurrentUser, setCurrentUser } from './current-user-store';
import {
  acknowledgeRecoveryCodes,
  discardPendingRecoveryCodes,
  setPendingRecoveryCodes,
} from './recovery-codes-store';
import { clearPasswordChangeRequired } from './password-change-gate';
import { API_BASE } from '../api/config';
import type { components } from '../api/generated/openapi-types';

type AuthResult = components['schemas']['AuthResult'];
type MfaChallenge = components['schemas']['MfaChallenge'];
type MfaEnrolResponse = components['schemas']['MfaEnrolResponse'];
type MfaEnrolConfirmResponse = components['schemas']['MfaEnrolConfirmResponse'];
type Problem = components['schemas']['Problem'];

/**
 * Login/refresh/logout and the whole `/auth/mfa/*` family live outside
 * `SyncTransport` — they are not part of the offline outbox contract, and
 * they must never become part of it. Nothing about authenticating is
 * queueable: a queued sign-in would be a credential sitting in IndexedDB
 * waiting to be replayed against a server that has since locked the account,
 * and a queued TOTP code would be worthless by the time it drained (it is
 * valid for one 30-second step). Every function in this module therefore
 * calls `fetch` directly, exactly as `login`/`refresh`/`stepUp` already did,
 * and reports failure to its caller instead of retrying.
 *
 * Non-negotiable #10: the refresh token is an HttpOnly cookie the browser
 * attaches via `credentials: 'include'` — never read or written here; the
 * access token goes straight to `token-store` (memory only); the MFA
 * challenge token goes straight to `challenge-store` (memory only).
 *
 * Nothing here logs a request or response body. These paths carry passwords,
 * TOTP codes, recovery codes and the TOTP shared secret.
 */

/**
 * The result of an auth call that has SCREEN-VISIBLE non-2xx outcomes, which
 * the MFA endpoints all do (401 wrong code / expired challenge, 409 already
 * enrolled, 422 policy, 429 rate limit). Mirrors `JobActionResponse` in
 * `api/transport.ts` rather than throwing, for the same reason: the caller
 * must branch on the outcome, not treat it as transport failure.
 *
 * `status: 0` means no response reached us at all (offline, DNS, TLS). It is
 * distinguished from every real status because "you are offline" is the one
 * message the user can act on, and an auth flow that silently looked like a
 * wrong code would be actively misleading.
 */
export type AuthCallResult<T> =
  { ok: true; status: number; value: T } | { ok: false; status: number; problem?: Problem };

/** What `POST /auth/login` did, decided by WHAT THE SERVER RETURNED — never
 * by a client-side flag (#6). With `MFA_ENABLED=false`, which is production
 * today, only `authenticated` is ever produced and the sign-in screen behaves
 * exactly as it did before this slice. */
export type LoginOutcome =
  { kind: 'authenticated'; auth: AuthResult } | { kind: 'mfa-challenge'; mfaEnrolled: boolean };

/**
 * The one place the two possible `POST /auth/login` bodies are told apart.
 * Keyed on `mfaRequired === true`, which `api/openapi.yaml` declares as a
 * `const: true` discriminator on `MfaChallenge` and which `AuthResult` does
 * not carry at all. Deliberately NOT keyed on "is `accessToken` missing",
 * which would turn any malformed success body into a silent MFA prompt.
 */
function isMfaChallenge(body: AuthResult | MfaChallenge): body is MfaChallenge {
  return (body as MfaChallenge).mfaRequired === true;
}

/**
 * Applies a successful authentication: memory-only token, principal cached
 * for presentation, and any spent MFA challenge dropped.
 *
 * It also drops the two latches that describe a SESSION rather than a device
 * — the forced-password-change gate and any pending recovery codes — but only
 * when the principal is not the one already held (review finding m3). Both
 * are module-level and survive an `authed` transition, so without this a
 * second user signing in on the same page instance inherits the first user's
 * state: shown `<ChangePassword forced />` the server never asked them for,
 * or handed ten recovery codes that are not theirs.
 *
 * The comparison matters as much as the clearing. `refresh()` runs
 * `acceptAuthResult` for the SAME user on every proactive token rotation, and
 * that can land while they are reading the recovery-codes screen or sitting on
 * the forced-change screen; clearing unconditionally would yank either away
 * mid-use — the codes-lost failure this slice exists to prevent. An absent
 * cached principal counts as a change, because `refresh()` clears it on
 * failure and that is precisely the path by which a different user reaches a
 * sign-in on this page.
 */
function acceptAuthResult(auth: AuthResult): void {
  if (getCurrentUser()?.id !== auth.user.id) {
    clearPasswordChangeRequired();
    discardPendingRecoveryCodes();
  }
  setAccessToken(auth.accessToken, auth.expiresIn);
  setCurrentUser(auth.user);
  clearChallenge();
}

async function readProblem(res: Response): Promise<Problem | undefined> {
  return (await res.json().catch(() => undefined)) as Problem | undefined;
}

/** Wraps a fetch so a dead network becomes `status: 0` rather than an
 * exception every caller would have to catch identically. */
async function call<T>(
  path: string,
  init: RequestInit,
  parse: (res: Response) => Promise<T>,
): Promise<AuthCallResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status, problem: await readProblem(res) };
  return { ok: true, status: res.status, value: await parse(res) };
}

const jsonHeaders = { 'Content-Type': 'application/json' } as const;

/**
 * `POST /auth/login`. Throws on a rejected password exactly as it always has,
 * so `SignIn`'s existing PR-007 catch (which never reveals WHY) is unchanged.
 * A 200 may now be either shape; the caller is told which by `kind`.
 */
export async function login(email: string, password: string): Promise<LoginOutcome> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status}`);
  }
  const body = (await res.json()) as AuthResult | MfaChallenge;
  if (isMfaChallenge(body)) {
    // No access token and no refresh cookie came with this response. The
    // challenge token is the ONLY credential we now hold, and it lives in
    // memory (challenge-store) for its five-minute life.
    setChallenge(body.challengeToken, body.expiresIn, body.mfaEnrolled);
    return { kind: 'mfa-challenge', mfaEnrolled: body.mfaEnrolled };
  }
  acceptAuthResult(body);
  return { kind: 'authenticated', auth: body };
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
    clearCurrentUser();
    return null;
  }
  const body = (await res.json()) as AuthResult;
  acceptAuthResult(body);
  return body;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {
    // Best-effort: even if the request fails, the local session must end.
  });
  clearAccessToken();
  clearCurrentUser();
  clearChallenge();
  clearPasswordChangeRequired();
  acknowledgeRecoveryCodes();
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
      ...jsonHeaders,
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

// ----------------------------------------------------------- slice 13: MFA

/** True while a `/auth/login` MFA challenge is still redeemable. */
export function hasLiveChallenge(): boolean {
  return !isChallengeExpired();
}

/**
 * `/auth/mfa/enrol` and `/auth/mfa/enrol/confirm` accept EITHER credential
 * (openapi: `bearerAuth` OR the body `challengeToken`). Which one we hold is
 * a fact about this device's state, not a permission decision: mid-login we
 * have only the challenge token; enrolling voluntarily we have only an access
 * token. Preferring the challenge token matters — an in-flight challenge
 * means the login is not finished, so there is no session to enrol under.
 */
function enrolCredential(): { body: Record<string, string>; headers: Record<string, string> } {
  const challengeToken = getChallengeToken();
  if (challengeToken) return { body: { challengeToken }, headers: {} };
  const token = getAccessToken();
  return { body: {}, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

/** `POST /auth/mfa/verify` — second step of login. On success this is an
 * ordinary authenticated session, indistinguishable from a one-step login. */
export async function verifyMfaCode(totpCode: string): Promise<AuthCallResult<AuthResult>> {
  const challengeToken = getChallengeToken();
  if (!challengeToken) return { ok: false, status: 401 };
  const result = await call<AuthResult>(
    '/auth/mfa/verify',
    { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ challengeToken, totpCode }) },
    (res) => res.json() as Promise<AuthResult>,
  );
  if (result.ok) acceptAuthResult(result.value);
  return result;
}

/** `POST /auth/mfa/recovery` — redeem one of the ten single-use codes. */
export async function redeemRecoveryCode(
  recoveryCode: string,
): Promise<AuthCallResult<AuthResult>> {
  const challengeToken = getChallengeToken();
  if (!challengeToken) return { ok: false, status: 401 };
  const result = await call<AuthResult>(
    '/auth/mfa/recovery',
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ challengeToken, recoveryCode }),
    },
    (res) => res.json() as Promise<AuthResult>,
  );
  if (result.ok) acceptAuthResult(result.value);
  return result;
}

/**
 * `POST /auth/mfa/enrol` — mint a pending TOTP secret. Calling it again
 * before confirmation REPLACES the pending secret, which is exactly what the
 * "start over" affordance on the enrolment screen needs. 409 means the
 * account is already enrolled and only an ADMIN reset can undo that.
 */
export async function beginMfaEnrolment(): Promise<AuthCallResult<MfaEnrolResponse>> {
  const { body, headers } = enrolCredential();
  return call<MfaEnrolResponse>(
    '/auth/mfa/enrol',
    { method: 'POST', headers: { ...jsonHeaders, ...headers }, body: JSON.stringify(body) },
    (res) => res.json() as Promise<MfaEnrolResponse>,
  );
}

/**
 * `POST /auth/mfa/enrol/confirm` — the ten recovery codes come back HERE and
 * nowhere else, ever again. When this call rode a challenge token it also
 * completes the login, and `auth` carries the session; for a voluntary
 * enrolment `auth` is null and the caller keeps the session it already had.
 */
export async function confirmMfaEnrolment(
  totpCode: string,
): Promise<AuthCallResult<MfaEnrolConfirmResponse>> {
  const { body, headers } = enrolCredential();
  const result = await call<MfaEnrolConfirmResponse>(
    '/auth/mfa/enrol/confirm',
    {
      method: 'POST',
      headers: { ...jsonHeaders, ...headers },
      body: JSON.stringify({ ...body, totpCode }),
    },
    (res) => res.json() as Promise<MfaEnrolConfirmResponse>,
  );
  if (result.ok) {
    // Order matters, in THIS direction: `acceptAuthResult` discards latched
    // state belonging to a different principal (see it, and m3), and mid-login
    // there is no cached principal yet — so it counts as a change and would
    // wipe codes latched before it. Swap these two lines and the ten codes are
    // discarded a microsecond after they arrive; U-AUTH-19 and the E-06
    // journey both go red, which is how this is held in place rather than by
    // this comment.
    //
    // What keeps the codes alive ACROSS the authentication itself is not the
    // ordering: it is that `recovery-codes-store` is a module-level latch with
    // subscribers, and that `App` renders `RecoveryCodes` ahead of every other
    // authenticated screen (`App.tsx`). The sign-in tree holding this
    // component is unmounted the instant the session is applied; nothing
    // rendered inside it could survive.
    if (result.value.auth) acceptAuthResult(result.value.auth);
    setPendingRecoveryCodes(result.value.recoveryCodes);
  }
  return result;
}

/** Abandons an in-flight challenge — "start again" on the sign-in screen,
 * and the automatic path when the five minutes lapse. */
export function abandonChallenge(): void {
  clearChallenge();
}

// ------------------------------------------------- slice 13: password self-service

/**
 * `POST /auth/password`. Deliberately NOT routed through
 * `authorizedFetch`: this is one of only three endpoints a
 * `must_change_password` user may call, so it must work while every other
 * request in the app is being refused 403, and it must not itself be able to
 * trip the forced-change latch.
 *
 * On success the server revokes every OTHER refresh-token family and clears
 * the flag; our own session survives, so the latch is released here and the
 * user continues without signing in again.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthCallResult<void>> {
  const token = getAccessToken();
  const result = await call<void>(
    '/auth/password',
    {
      method: 'POST',
      headers: { ...jsonHeaders, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ currentPassword, newPassword }),
    },
    async () => undefined,
  );
  if (result.ok) clearPasswordChangeRequired();
  return result;
}

/**
 * `POST /users/{userId}/mfa-reset` — ADMIN only, enforced entirely by the
 * server. Destructive: it clears the subject's enrolment and burns every
 * unused recovery code, so they must enrol a fresh authenticator at their
 * next login. No endpoint anywhere lets an admin READ a secret or a code.
 */
export async function resetUserMfa(userId: string): Promise<AuthCallResult<void>> {
  const token = getAccessToken();
  return call<void>(
    `/users/${encodeURIComponent(userId)}/mfa-reset`,
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    async () => undefined,
  );
}
