import type { components } from '../api/generated/openapi-types';

type Problem = components['schemas']['Problem'];

/**
 * Slice 13-MFA §7 shipped a global, deny-by-default server guard: a user
 * whose `must_change_password` flag is set gets
 * `403 /errors/password-change-required` from EVERY endpoint except
 * `GET /auth/me`, `POST /auth/password` and `POST /auth/logout`. The review's
 * finding I-3 spelled out what that means without a UI: the user signs in
 * fine and then every screen fails with a generic error they cannot act on.
 *
 * This module is the client half. It is a LATCH, not a decision:
 *
 *  - Non-negotiable #6 (no authz in `web`) is intact. Nothing here works out
 *    whether a password change is due — it only records that the SERVER just
 *    said so, and forgets it when the server accepts a new password. The web
 *    app never predicts the 403; it reacts to one.
 *  - Detection lives in one place, the transport layer
 *    (`api/http-transport.ts#authorizedFetch`), rather than being repeated in
 *    each screen. Every authenticated call in the app already goes through
 *    that function, so a screen added in a future slice inherits the
 *    behaviour without knowing this module exists.
 */

let required = false;
const listeners = new Set<(required: boolean) => void>();

/** The `type` the server sends. Compared with `endsWith` (13-UI-A review
 * m4): it tolerates the relative/absolute prefix split — the api emits the
 * relative `/errors/password-change-required` while other problem documents
 * carry the absolute `https://form.bevorasg.com/...` prefix — but, unlike
 * the previous `includes`, it cannot latch the global gate for any problem
 * whose type merely CONTAINS the phrase somewhere in the middle. */
export function isPasswordChangeRequiredProblem(problem: unknown): boolean {
  const type = (problem as Problem | undefined)?.type;
  return typeof type === 'string' && type.endsWith('/errors/password-change-required');
}

export function markPasswordChangeRequired(): void {
  if (required) return;
  required = true;
  for (const listener of listeners) listener(required);
}

/** Called after `POST /auth/password` succeeds — the server has cleared the
 * flag, so the latch must clear too or the user stays trapped on the screen
 * that just worked. */
export function clearPasswordChangeRequired(): void {
  if (!required) return;
  required = false;
  for (const listener of listeners) listener(required);
}

export function isPasswordChangeRequired(): boolean {
  return required;
}

export function onPasswordChangeRequired(listener: (required: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: guarantees no latch state leaks between test cases. */
export function _resetForTests(): void {
  required = false;
  listeners.clear();
}
