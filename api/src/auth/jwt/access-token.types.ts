import type { KeyObject } from 'node:crypto';

/**
 * PR-086: token claims carry ONLY these seven — no personal data. `roles` is
 * the only custom claim; everything else is a JWT registered claim.
 */
export interface AccessTokenClaims {
  sub: string;
  roles: string[];
  jti: string;
  iat: number;
  exp: number;
  aud: string;
  iss: string;
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
}

/** Resolves a verification (public) key by `kid` from the JWKS in force. */
export type VerificationKeyResolver = (kid: string | undefined) => KeyObject;
