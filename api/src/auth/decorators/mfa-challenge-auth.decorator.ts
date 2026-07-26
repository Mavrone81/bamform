import { SetMetadata } from '@nestjs/common';

export const MFA_CHALLENGE_AUTH_KEY = 'mfaChallengeAuth';

export type MfaChallengeAuthMode =
  /**
   * Only an MFA challenge token (in the request body's `challengeToken`) is
   * accepted. Used by `/auth/mfa/verify` and `/auth/mfa/recovery`, which
   * exist solely to COMPLETE a login — a caller that already holds an access
   * token has nothing to do here.
   */
  | 'challenge-only'
  /**
   * A challenge token OR a normal `Authorization: Bearer` access token.
   * Used by `/auth/mfa/enrol` and `/auth/mfa/enrol/confirm`, which serve two
   * populations: a user mid-login who must enrol before they can finish
   * (brief §4.4), and an already-signed-in user enrolling voluntarily ahead
   * of the `MFA_ENABLED` flip (brief §2).
   */
  | 'challenge-or-access';

/**
 * Marks a route as authenticated by the short-lived MFA challenge token
 * rather than (or as well as) an access token.
 *
 * This is deliberately NOT `@Public()`. Deny-by-default (PR-SEC-05) is
 * preserved: `JwtAuthGuard` still demands a signed, unexpired, non-denylisted
 * token on these routes — just one minted by `MfaChallengeTokenService`, with
 * its own audience and `typ`. Consequently these routes do NOT appear in
 * `known-gaps.ts`'s `PUBLIC_ROUTES` and `route-coverage.spec.ts` still
 * requires `isPublic === false` for them, which is the property we want:
 * adding an MFA endpoint can never quietly open an unauthenticated hole.
 */
export const MfaChallengeAuth = (mode: MfaChallengeAuthMode) =>
  SetMetadata(MFA_CHALLENGE_AUTH_KEY, mode);
