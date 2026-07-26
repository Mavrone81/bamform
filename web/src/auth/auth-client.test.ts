import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abandonChallenge,
  beginMfaEnrolment,
  changePassword,
  confirmMfaEnrolment,
  ensureFreshToken,
  hasLiveChallenge,
  login,
  logout,
  redeemRecoveryCode,
  refresh,
  resetUserMfa,
  stepUp,
  verifyMfaCode,
} from './auth-client';
import {
  getAccessToken,
  isTokenStale,
  setAccessToken,
  _resetForTests as resetTokens,
} from './token-store';
import {
  assertChallengeNeverPersisted,
  getChallengeToken,
  isChallengedUserEnrolled,
  setChallenge,
  _resetForTests as resetChallenge,
} from './challenge-store';
import { getCurrentUser, _resetForTests as resetUser } from './current-user-store';
import {
  isPasswordChangeRequired,
  markPasswordChangeRequired,
  _resetForTests as resetGate,
} from './password-change-gate';
import {
  getPendingRecoveryCodes,
  setPendingRecoveryCodes,
  _resetForTests as resetRecoveryCodes,
} from './recovery-codes-store';

const USER = { id: 'u1', fullName: 'A', roles: ['ADMIN'] };
const AUTH_RESULT = { accessToken: 'tok-1', expiresIn: 900, user: USER };

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 401): Response {
  return { ok, status, json: async () => body } as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status < 400,
    status,
    json: async () => {
      throw new SyntaxError('no body');
    },
  } as unknown as Response;
}

function lastCall() {
  const calls = vi.mocked(fetch).mock.calls;
  const [url, init] = calls[calls.length - 1];
  return {
    url: String(url),
    init: init as RequestInit,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
  };
}

beforeEach(() => {
  resetTokens();
  resetChallenge();
  resetUser();
  resetGate();
  resetRecoveryCodes();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login — the response has two possible shapes', () => {
  it('U-AUTH-01: an AuthResult body authenticates in one step, exactly as before slice 13', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));

    const outcome = await login('tech@bevorasg.com', 'password12345');

    expect(outcome).toEqual({ kind: 'authenticated', auth: AUTH_RESULT });
    expect(getAccessToken()).toBe('tok-1');
    expect(getCurrentUser()).toEqual(USER);
    expect(getChallengeToken()).toBeNull();
    const { url, init } = lastCall();
    expect(url).toContain('/auth/login');
    expect(init.credentials).toBe('include'); // needed to receive the HttpOnly refresh cookie
  });

  it('U-AUTH-02: an MfaChallenge body issues NO access token and holds the challenge in memory', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        mfaRequired: true,
        mfaEnrolled: true,
        challengeToken: 'challenge-abc',
        expiresIn: 300,
      }),
    );

    const outcome = await login('admin@bevorasg.com', 'password12345');

    expect(outcome).toEqual({ kind: 'mfa-challenge', mfaEnrolled: true });
    expect(getAccessToken()).toBeNull(); // the login is NOT finished
    expect(getCurrentUser()).toBeNull();
    expect(getChallengeToken()).toBe('challenge-abc');
    expect(isChallengedUserEnrolled()).toBe(true);
  });

  it('U-AUTH-03: the branch is taken on what the SERVER returned, not on a client-side flag', async () => {
    // Same client, same call, two servers. Only the body differs, and that
    // alone decides the outcome — there is no MFA_ENABLED equivalent in web.
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        mfaRequired: true,
        mfaEnrolled: false,
        challengeToken: 'challenge-xyz',
        expiresIn: 300,
      }),
    );
    expect(await login('a@b.com', 'password12345')).toEqual({
      kind: 'mfa-challenge',
      mfaEnrolled: false,
    });

    resetChallenge();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));
    expect((await login('a@b.com', 'password12345')).kind).toBe('authenticated');
  });

  it('U-AUTH-04: a body missing accessToken is NOT mistaken for a challenge', async () => {
    // Keying on "no accessToken" instead of the `mfaRequired` discriminator
    // would turn any malformed success into a silent MFA prompt.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ expiresIn: 900, user: USER }));
    const outcome = await login('a@b.com', 'password12345');
    expect(outcome.kind).toBe('authenticated');
    expect(getChallengeToken()).toBeNull();
  });

  it('U-AUTH-05: throws on a non-OK response and sets neither token nor challenge', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));
    await expect(login('tech@bevorasg.com', 'wrong')).rejects.toThrow('login failed: 401');
    expect(getAccessToken()).toBeNull();
    expect(getChallengeToken()).toBeNull();
  });
});

describe('the challenge token is a token (non-negotiable #10)', () => {
  it('U-AUTH-06: is never written to localStorage or sessionStorage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        mfaRequired: true,
        mfaEnrolled: true,
        challengeToken: 'challenge-secret-value',
        expiresIn: 300,
      }),
    );
    await login('admin@bevorasg.com', 'password12345');

    expect(() => assertChallengeNeverPersisted()).not.toThrow();
    const persisted = [
      ...Object.values(window.localStorage),
      ...Object.values(window.sessionStorage),
    ].join('|');
    expect(persisted).not.toContain('challenge-secret-value');
  });

  it('U-AUTH-07: is dropped as soon as the session it was exchanged for exists', async () => {
    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));

    await verifyMfaCode('123456');

    expect(getChallengeToken()).toBeNull();
    expect(hasLiveChallenge()).toBe(false);
    expect(getAccessToken()).toBe('tok-1');
  });

  it('U-AUTH-08: abandonChallenge discards it without a network call', () => {
    setChallenge('challenge-abc', 300, true);
    abandonChallenge();
    expect(getChallengeToken()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('verifyMfaCode', () => {
  it('U-AUTH-09: sends the in-memory challenge token with the code and stores the session', async () => {
    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));

    const result = await verifyMfaCode('123456');

    expect(result).toEqual({ ok: true, status: 200, value: AUTH_RESULT });
    const { url, body, init } = lastCall();
    expect(url).toContain('/auth/mfa/verify');
    expect(body).toEqual({ challengeToken: 'challenge-abc', totpCode: '123456' });
    expect(init.credentials).toBe('include');
    expect(getCurrentUser()).toEqual(USER);
  });

  it('U-AUTH-10: surfaces a rejected code as 401 without touching the session', async () => {
    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ type: '/errors/invalid-credentials', title: 'Invalid', status: 401 }, false),
    );

    const result = await verifyMfaCode('000000');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(getAccessToken()).toBeNull();
    // The challenge survives a WRONG CODE — the server only burns it on a
    // successful redemption (api mfa.service.ts `claimChallenge`), so the
    // user gets to retype rather than start from their password again.
    expect(getChallengeToken()).toBe('challenge-abc');
  });

  it('U-AUTH-11: refuses locally, with no request at all, once the challenge has lapsed', async () => {
    setChallenge('challenge-abc', -1, true); // already expired
    const result = await verifyMfaCode('123456');
    expect(result).toEqual({ ok: false, status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('U-AUTH-12: reports a dead network as status 0, distinctly from a rejected code', async () => {
    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await verifyMfaCode('123456');
    expect(result).toEqual({ ok: false, status: 0 });
  });
});

describe('redeemRecoveryCode', () => {
  it('U-AUTH-13: posts the challenge token with the recovery code', async () => {
    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));

    const result = await redeemRecoveryCode('ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ01-2345');

    expect(result.ok).toBe(true);
    const { url, body } = lastCall();
    expect(url).toContain('/auth/mfa/recovery');
    expect(body).toEqual({
      challengeToken: 'challenge-abc',
      recoveryCode: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ01-2345',
    });
    expect(getAccessToken()).toBe('tok-1');
  });

  it('U-AUTH-14: refuses locally with no challenge, and reports a reused code as 401', async () => {
    expect(await redeemRecoveryCode('anything')).toEqual({ ok: false, status: 401 });
    expect(fetch).not.toHaveBeenCalled();

    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(401));
    const result = await redeemRecoveryCode('already-used');
    expect(result).toEqual({ ok: false, status: 401, problem: undefined });
  });
});

describe('enrolment', () => {
  it('U-AUTH-15: mid-login, authorises with the challenge token in the body and no Bearer header', async () => {
    setChallenge('challenge-abc', 300, false);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ secret: 'JBSWY3DP', otpauthUri: 'otpauth://totp/BamForm:a%40b.com?secret=X' }),
    );

    const result = await beginMfaEnrolment();

    expect(result.ok).toBe(true);
    const { url, body, headers } = lastCall();
    expect(url).toContain('/auth/mfa/enrol');
    expect(body).toEqual({ challengeToken: 'challenge-abc' });
    expect(headers.Authorization).toBeUndefined();
  });

  it('U-AUTH-16: signed in and enrolling voluntarily, authorises with the access token instead', async () => {
    setAccessToken('tok-9', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ secret: 'S', otpauthUri: 'otpauth://' }));

    await beginMfaEnrolment();

    const { body, headers } = lastCall();
    expect(body).toEqual({});
    expect(headers.Authorization).toBe('Bearer tok-9');
  });

  it('U-AUTH-17: sends no credential at all when it holds neither', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(401));
    const result = await beginMfaEnrolment();
    expect(result.ok).toBe(false);
    expect(lastCall().headers.Authorization).toBeUndefined();
  });

  it('U-AUTH-18: reports 409 already-enrolled distinctly, so the UI can explain it', async () => {
    setChallenge('challenge-abc', 300, false);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        { type: '/errors/conflict', title: 'Already enrolled', status: 409 },
        false,
        409,
      ),
    );

    const result = await beginMfaEnrolment();

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.ok === false && result.problem?.title).toBe('Already enrolled');
  });

  it('U-AUTH-19: confirming mid-login returns the ten codes AND completes the login', async () => {
    setChallenge('challenge-abc', 300, false);
    const codes = Array.from({ length: 10 }, (_, i) => `CODE-${i}`);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ recoveryCodes: codes, auth: AUTH_RESULT }),
    );

    const result = await confirmMfaEnrolment('123456');

    expect(result.ok && result.value.recoveryCodes).toEqual(codes);
    expect(lastCall().body).toEqual({ challengeToken: 'challenge-abc', totpCode: '123456' });
    expect(getAccessToken()).toBe('tok-1');
    expect(getChallengeToken()).toBeNull();
    // Latched, and latched AFTER the session was applied. `acceptAuthResult`
    // discards codes belonging to a different principal, and mid-login there
    // is no cached principal yet, so latching first would hand these straight
    // to it to be discarded. Swap the two lines in `confirmMfaEnrolment` and
    // this assertion is what goes red.
    expect(getPendingRecoveryCodes()).toEqual(codes);
  });

  it('U-AUTH-20: confirming a VOLUNTARY enrolment returns codes with auth null and keeps the session', async () => {
    setAccessToken('tok-9', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ recoveryCodes: ['A'], auth: null }));

    const result = await confirmMfaEnrolment('123456');

    expect(result.ok && result.value.auth).toBeNull();
    expect(getAccessToken()).toBe('tok-9'); // unchanged
    expect(getPendingRecoveryCodes()).toEqual(['A']);
  });

  it('U-AUTH-21: a rejected confirmation issues no session', async () => {
    setChallenge('challenge-abc', 300, false);
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(401));
    const result = await confirmMfaEnrolment('000000');
    expect(result.ok).toBe(false);
    expect(getAccessToken()).toBeNull();
    expect(getPendingRecoveryCodes()).toBeNull();
  });
});

describe('changePassword', () => {
  it('U-AUTH-22: posts to /auth/password with the bearer token and releases the forced-change latch', async () => {
    setAccessToken('tok-9', 900);
    markPasswordChangeRequired();
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(204));

    const result = await changePassword('old-password-1', 'new-password-1234');

    expect(result.ok).toBe(true);
    const { url, headers, body } = lastCall();
    expect(url).toContain('/auth/password');
    expect(headers.Authorization).toBe('Bearer tok-9');
    expect(body).toEqual({ currentPassword: 'old-password-1', newPassword: 'new-password-1234' });
    expect(isPasswordChangeRequired()).toBe(false);
  });

  it('U-AUTH-23: leaves the latch set when the server rejects the change', async () => {
    setAccessToken('tok-9', 900);
    markPasswordChangeRequired();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ type: '/errors/invalid-credentials', title: 'Nope', status: 401 }, false),
    );

    const result = await changePassword('wrong', 'new-password-1234');

    expect(result.ok).toBe(false);
    expect(isPasswordChangeRequired()).toBe(true);
  });

  it('U-AUTH-24: still sends the request when no access token is held, rather than guessing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(401));
    await changePassword('a', 'b');
    expect(lastCall().headers.Authorization).toBeUndefined();
  });
});

describe('resetUserMfa', () => {
  it('U-AUTH-25: posts to the admin reset path with the bearer token', async () => {
    setAccessToken('tok-9', 900);
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(204));

    const result = await resetUserMfa('01920000-0000-7000-8000-000000000001');

    expect(result.ok).toBe(true);
    const { url, headers } = lastCall();
    expect(url).toContain('/users/01920000-0000-7000-8000-000000000001/mfa-reset');
    expect(headers.Authorization).toBe('Bearer tok-9');
  });

  it('U-AUTH-26: percent-encodes the id and surfaces a 403 for the server to explain', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ type: '/errors/forbidden', title: 'Forbidden', status: 403 }, false, 403),
    );

    const result = await resetUserMfa('a b/c');

    expect(lastCall().url).toContain('/users/a%20b%2Fc/mfa-reset');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe('refresh', () => {
  it('relies on the HttpOnly cookie (no body sent) and stores the new access token', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ...AUTH_RESULT, accessToken: 'tok-2' }));

    const result = await refresh();

    expect(result?.accessToken).toBe('tok-2');
    expect(getAccessToken()).toBe('tok-2');
    expect(getCurrentUser()).toEqual(USER);
    expect(lastCall().init.credentials).toBe('include');
  });

  it('clears the held token AND the cached principal when the refresh cookie is rejected', async () => {
    setAccessToken('tok-old', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));

    expect(await refresh()).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(getCurrentUser()).toBeNull();
  });
});

describe('latched state belongs to a principal, not to the page (review finding m3)', () => {
  const OTHER_USER = { id: 'u2', fullName: 'B', roles: ['MAINTAINER'] };
  const OTHER_AUTH = { accessToken: 'tok-2', expiresIn: 900, user: OTHER_USER };

  it('U-AUTH-28: a different principal does not inherit the forced-change latch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));
    await login('a@b.com', 'password12345');
    markPasswordChangeRequired();

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(OTHER_AUTH));
    await login('b@b.com', 'password12345');

    // Without this, user B is shown `<ChangePassword forced />` that the
    // server never asked for, and cannot leave it until they change a password
    // that was never flagged.
    expect(isPasswordChangeRequired()).toBe(false);
    expect(getCurrentUser()).toEqual(OTHER_USER);
  });

  it('U-AUTH-29: nor the previous principal’s pending recovery codes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));
    await login('a@b.com', 'password12345');
    setPendingRecoveryCodes(['A-CODE']);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(OTHER_AUTH));
    await login('b@b.com', 'password12345');

    expect(getPendingRecoveryCodes()).toBeNull();
  });

  it('U-AUTH-30: and not after a failed refresh dropped the cached principal — the path that makes this reachable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));
    await login('a@b.com', 'password12345');
    markPasswordChangeRequired();
    setPendingRecoveryCodes(['A-CODE']);

    // `refresh()` clears the token and the principal but leaves the latches —
    // this is exactly how `authed` goes false without a `logout()`.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));
    expect(await refresh()).toBeNull();
    expect(getCurrentUser()).toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(OTHER_AUTH));
    await login('b@b.com', 'password12345');

    expect(isPasswordChangeRequired()).toBe(false);
    expect(getPendingRecoveryCodes()).toBeNull();
  });

  it('U-AUTH-31: a token rotation for the SAME principal keeps both, or it would yank a screen out from under them', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(AUTH_RESULT));
    await login('a@b.com', 'password12345');
    markPasswordChangeRequired();
    setPendingRecoveryCodes(['A-CODE']);

    // A proactive refresh can land while the user is reading their recovery
    // codes or sitting on the forced-change screen. Clearing unconditionally
    // would destroy the only copy of ten one-time credentials — the very
    // failure `recovery-codes-store` exists to prevent.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ...AUTH_RESULT, accessToken: 'tok-3' }));
    expect((await refresh())?.accessToken).toBe('tok-3');

    expect(isPasswordChangeRequired()).toBe(true);
    expect(getPendingRecoveryCodes()).toEqual(['A-CODE']);
  });
});

describe('logout', () => {
  it('clears every piece of in-memory auth state, including a half-finished challenge', async () => {
    setAccessToken('tok-1', 900);
    setChallenge('challenge-abc', 300, true);
    markPasswordChangeRequired();
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(204));

    await logout();

    expect(getAccessToken()).toBeNull();
    expect(getChallengeToken()).toBeNull();
    expect(getCurrentUser()).toBeNull();
    expect(isPasswordChangeRequired()).toBe(false);
    expect(getPendingRecoveryCodes()).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('/auth/logout'),
      expect.anything(),
    );
  });

  it('still clears local state even if the network call fails outright', async () => {
    setAccessToken('tok-1', 900);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    await expect(logout()).resolves.toBeUndefined();
    expect(getAccessToken()).toBeNull();
  });

  // Fix-delta re-review, finding C-1. `POST /auth/logout` is NOT @Public() and
  // is covered by openapi.yaml's global `security: [bearerAuth]`, so a
  // header-less call 401s. Confirmed against live production: without the
  // header 401 and `POST /auth/refresh` still returns 200 (the session
  // survives); with it 204 and refresh then 401.
  //
  // The bug hid because a 401 is not a fetch rejection: the local state above
  // still clears, so the UI looks signed out while the server-side refresh
  // family is never revoked. `bf_refresh` (30-day TTL) then resurrects the
  // session on the next mount — on a shared plant-floor tablet, silently
  // authenticating the next person AS THE PREVIOUS USER, who can then sign
  // records under that identity. That is an ISO-13485 attribution failure.
  //
  // The sibling test above passes `expect.anything()` for the request options,
  // which is exactly why it never caught this. Assert the header itself.
  it('sends the bearer token — without it the server 401s and the session survives (C-1)', async () => {
    setAccessToken('tok-logout', 900);
    vi.mocked(fetch).mockResolvedValueOnce(emptyResponse(204));

    await logout();

    const [, init] = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes('/auth/logout'))!;
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok-logout',
    });
    expect((init as RequestInit).credentials).toBe('include');
  });
});

describe('ensureFreshToken', () => {
  it('returns the current token without a network call when it is not stale', async () => {
    setAccessToken('tok-3', 900);
    const token = await ensureFreshToken();
    expect(token).toBe('tok-3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes when there is no token yet', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ...AUTH_RESULT, accessToken: 'tok-4' }));
    expect(await ensureFreshToken()).toBe('tok-4');
    expect(isTokenStale()).toBe(false);
  });

  it('returns null when the refresh is rejected', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));
    expect(await ensureFreshToken()).toBeNull();
  });
});

describe('stepUp', () => {
  it('PR-API-07: sends the bearer token + password and resolves on success', async () => {
    setAccessToken('tok-5', 900);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ stepUpValidUntil: '2026-07-24T02:30:00Z' }),
    );

    await expect(stepUp('correct-horse-battery-staple')).resolves.toBeUndefined();

    const { url, init, headers, body } = lastCall();
    expect(url).toContain('/auth/step-up');
    expect(init.credentials).toBe('include');
    expect(headers.Authorization).toBe('Bearer tok-5');
    expect(body).toEqual({ password: 'correct-horse-battery-staple' });
  });

  it('throws (never revealing why) on a rejected step-up, and never retains the password', async () => {
    setAccessToken('tok-6', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 401));
    await expect(stepUp('wrong-password')).rejects.toThrow('step-up failed: 401');
  });

  it('omits the Authorization header when no access token is held', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ stepUpValidUntil: '2026-07-24T02:30:00Z' }),
    );
    await stepUp('some-password');
    expect(lastCall().headers.Authorization).toBeUndefined();
  });
});

/**
 * U-AUTH-27 — brief §3: "Authentication must never enter the offline outbox."
 * The structural guarantee is that nothing in this module touches
 * `SyncTransport`, the Dexie database or `offline/outbox.ts`; this pins it
 * behaviourally as well. Every auth call is one direct `fetch` that either
 * succeeds or reports failure to its caller — there is no retry, no queue and
 * nothing left behind to drain later.
 */
describe('U-AUTH-27: auth never queues', () => {
  it('makes exactly one direct request per call and never retries a failed one', async () => {
    setChallenge('challenge-abc', 300, true);
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await verifyMfaCode('123456')).toEqual({ ok: false, status: 0 });
    expect(await redeemRecoveryCode('code')).toEqual({ ok: false, status: 0 });
    expect(await changePassword('a', 'b')).toEqual({ ok: false, status: 0 });
    expect(await beginMfaEnrolment()).toEqual({ ok: false, status: 0 });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(/\/auth\//);
    }
  });
});
