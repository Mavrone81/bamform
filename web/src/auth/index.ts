/**
 * The auth barrel. Deliberately explicit rather than four `export *` lines:
 * `token-store`, `challenge-store`, `current-user-store`,
 * `recovery-codes-store` and `password-change-gate` each expose a
 * `_resetForTests`, and a wildcard
 * re-export of four same-named symbols is ambiguous. Tests import that helper
 * from the specific module it belongs to; application code never needs it.
 */
export {
  setAccessToken,
  clearAccessToken,
  getAccessToken,
  isTokenStale,
  onTokenChange,
  scanStorageForLeak,
  assertTokenNeverPersisted,
  type TokenState,
} from './token-store';

export {
  setChallenge,
  clearChallenge,
  getChallengeToken,
  isChallengeExpired,
  isChallengedUserEnrolled,
  challengeMillisRemaining,
  assertChallengeNeverPersisted,
} from './challenge-store';

export {
  setCurrentUser,
  getCurrentUser,
  clearCurrentUser,
  onCurrentUserChange,
  currentUserHasRole,
} from './current-user-store';

export {
  setPendingRecoveryCodes,
  getPendingRecoveryCodes,
  acknowledgeRecoveryCodes,
  onPendingRecoveryCodesChange,
} from './recovery-codes-store';

export {
  isPasswordChangeRequiredProblem,
  markPasswordChangeRequired,
  clearPasswordChangeRequired,
  isPasswordChangeRequired,
  onPasswordChangeRequired,
} from './password-change-gate';

export {
  login,
  refresh,
  logout,
  ensureFreshToken,
  stepUp,
  hasLiveChallenge,
  verifyMfaCode,
  redeemRecoveryCode,
  beginMfaEnrolment,
  confirmMfaEnrolment,
  abandonChallenge,
  changePassword,
  resetUserMfa,
  type AuthCallResult,
  type LoginOutcome,
} from './auth-client';
