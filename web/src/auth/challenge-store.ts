/**
 * The MFA challenge token, held in memory ONLY.
 *
 * Non-negotiable #10 is usually quoted about the access token, but
 * `shared/src/mfa.ts` and `api/openapi.yaml` both say it in as many words for
 * this one too: "`challengeToken` is a TOKEN … the client holds it in memory
 * only and must never write it to `localStorage`/`sessionStorage`." It is a
 * bearer credential that authorises `/auth/mfa/verify`, `/auth/mfa/recovery`,
 * `/auth/mfa/enrol` and `/auth/mfa/enrol/confirm` — everything needed to
 * finish someone's login — so persisting it would leave a five-minute
 * skeleton key on disk, readable by any script on the origin, surviving a
 * tab close.
 *
 * This module is deliberately the ONLY place it is held, mirroring
 * `token-store.ts` exactly: one code path to audit, one place a future edit
 * could break the rule, and one unit test (`challenge-store.test.ts`) that
 * asserts the property continuously rather than review catching it once.
 *
 * It is also self-expiring. The server gives the token a five-minute life and
 * makes it single-use; holding it past that would only produce an opaque 401
 * and a confusing dead end, so `getChallengeToken()` reports it gone as soon
 * as it is stale and the sign-in screen sends the user back to the password
 * step with an explanation.
 */

interface ChallengeState {
  token: string;
  /** Epoch ms the server said this challenge stops being usable. */
  expiresAt: number;
  /** What the SERVER reported — never a client-side judgement (#6). */
  mfaEnrolled: boolean;
}

let state: ChallengeState | null = null;

export function setChallenge(token: string, expiresInSeconds: number, mfaEnrolled: boolean): void {
  state = { token, expiresAt: Date.now() + expiresInSeconds * 1000, mfaEnrolled };
}

export function clearChallenge(): void {
  state = null;
}

/** True once the challenge is gone — either never issued, spent, or stale. */
export function isChallengeExpired(): boolean {
  return state === null || Date.now() >= state.expiresAt;
}

/** The live token, or null if there isn't one (including "expired"). */
export function getChallengeToken(): string | null {
  if (isChallengeExpired()) return null;
  return state?.token ?? null;
}

/** Whether the challenged account already has an authenticator enrolled, as
 * reported by `POST /auth/login`. Null when no challenge is in flight. */
export function isChallengedUserEnrolled(): boolean | null {
  if (isChallengeExpired()) return null;
  return state?.mfaEnrolled ?? null;
}

/** Milliseconds left on the challenge — the sign-in screen uses this to send
 * the user back to the password step the moment it lapses, rather than
 * letting them type a code into a request that is guaranteed to 401. */
export function challengeMillisRemaining(): number {
  if (state === null) return 0;
  return Math.max(0, state.expiresAt - Date.now());
}

/** Test-only: guarantees no challenge leaks between test cases. */
export function _resetForTests(): void {
  state = null;
}

/**
 * Defence-in-depth guard, not the mechanism (the mechanism is simply "never
 * call localStorage/sessionStorage from this module"). Its value is that a
 * test can assert the property continuously: if a future edit starts
 * persisting the challenge token, this breaks immediately. Mirrors
 * `token-store.ts#assertTokenNeverPersisted`.
 */
export function assertChallengeNeverPersisted(): void {
  for (const [storage, name] of [
    [window.localStorage, 'localStorage'],
    [window.sessionStorage, 'sessionStorage'],
  ] as const) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const value = key ? storage.getItem(key) : null;
      if (value && state && value.includes(state.token)) {
        throw new Error(`MFA challenge token leaked into ${name} — non-negotiable #10 violated`);
      }
    }
  }
}
