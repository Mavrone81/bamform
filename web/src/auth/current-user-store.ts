import type { components } from '../api/generated/openapi-types';

type CurrentUser = components['schemas']['CurrentUser'];

/**
 * The signed-in principal exactly as the server last described it, held in
 * memory beside the access token and cleared with it.
 *
 * ⚠️ NOT an authorisation mechanism (non-negotiable #6). Nothing may branch on
 * `roles` to decide whether an action is ALLOWED — the server decides that and
 * returns 403 when the answer is no. Its only legitimate use is presentation:
 * not offering a control that would certainly fail is a kindness, and
 * `slice-13-ui-a-brief.md` §3 says so explicitly ("Hiding an ADMIN-only
 * control in the UI is fine as presentation; it is never the enforcement").
 * `AdminMfaReset` is reachable by URL regardless, and the server rejects a
 * non-ADMIN caller there whatever this store says.
 */

let currentUser: CurrentUser | null = null;
const listeners = new Set<(user: CurrentUser | null) => void>();

export function setCurrentUser(user: CurrentUser | null): void {
  currentUser = user;
  for (const listener of listeners) listener(currentUser);
}

export function getCurrentUser(): CurrentUser | null {
  return currentUser;
}

export function clearCurrentUser(): void {
  setCurrentUser(null);
}

export function onCurrentUserChange(listener: (user: CurrentUser | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Presentation only — see the module doc. */
export function currentUserHasRole(role: string): boolean {
  return currentUser?.roles.includes(role) ?? false;
}

/** Test-only: guarantees no principal leaks between test cases. */
export function _resetForTests(): void {
  currentUser = null;
  listeners.clear();
}
