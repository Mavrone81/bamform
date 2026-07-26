/** DI token for `MfaChallengeTokenService`, which is a plain class (no `@Injectable()`) so the security tests can construct it with throwaway keys — same convention as `ACCESS_TOKEN_SERVICE`. */
export const MFA_CHALLENGE_TOKEN_SERVICE = Symbol('MFA_CHALLENGE_TOKEN_SERVICE');
