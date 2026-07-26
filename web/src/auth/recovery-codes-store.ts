/**
 * The ten recovery codes, between `POST /auth/mfa/enrol/confirm` returning
 * them and the user confirming they have written them down.
 *
 * WHY A STORE AND NOT COMPONENT STATE. Confirming enrolment mid-login also
 * COMPLETES the login: the response carries an `AuthResult`, so the moment it
 * is applied the app is authenticated and `App` swaps the sign-in screen for
 * the job list. A codes-are-shown-here component living inside `SignIn` is
 * therefore unmounted at the exact instant it has something to show, and the
 * only copy of ten one-time credentials disappears with it. Hoisting the
 * codes to a latch — the same shape as `password-change-gate.ts` — lets `App`
 * render them ACROSS that transition, which is the only arrangement in which
 * "shown once" does not mean "shown never".
 *
 * Memory only, and short-lived: cleared when the user acknowledges them and
 * on logout. They are never written to `localStorage`, `sessionStorage` or
 * IndexedDB, and never logged. The Download button on the screen writes a
 * file because the USER asked for one — that is the user saving their own
 * credential, which the flow requires.
 */

let pending: readonly string[] | null = null;
const listeners = new Set<(codes: readonly string[] | null) => void>();

export function setPendingRecoveryCodes(codes: readonly string[]): void {
  pending = codes;
  for (const listener of listeners) listener(pending);
}

export function getPendingRecoveryCodes(): readonly string[] | null {
  return pending;
}

/** The user has said they saved them. This is the only exit — there is no
 * endpoint that can ever show them again. */
export function acknowledgeRecoveryCodes(): void {
  if (pending === null) return;
  pending = null;
  for (const listener of listeners) listener(pending);
}

export function onPendingRecoveryCodesChange(
  listener: (codes: readonly string[] | null) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: guarantees no codes leak between test cases. */
export function _resetForTests(): void {
  pending = null;
  listeners.clear();
}
