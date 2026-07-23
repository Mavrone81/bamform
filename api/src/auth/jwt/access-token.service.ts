import { UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import type { AccessTokenClaims, SigningKey, VerificationKeyResolver } from './access-token.types';

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresAt: number; // epoch seconds
}

/**
 * Access token signing/verification — PR-083 (EdDSA/Ed25519, 15 min TTL),
 * PR-086 (claim allowlist), PR-089 (`alg: none` and `HS256` explicitly
 * rejected — S-01/S-02).
 *
 * Deliberately independent of Nest DI / file-mounted secrets so S-01..S-05
 * can construct it directly with throwaway generated keys — the security
 * property under test is the verifier configuration itself, not key
 * loading. `JwtKeysModule` wires the production instance from the
 * file-mounted signing key.
 */
export class AccessTokenService {
  constructor(
    private readonly signingKey: SigningKey,
    private readonly resolveVerificationKey: VerificationKeyResolver,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly ttlSeconds: number,
  ) {}

  async sign(userId: string, roles: string[]): Promise<SignedAccessToken> {
    const jti = uuidv7();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + this.ttlSeconds;

    const token = await new SignJWT({ roles })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.signingKey.kid })
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAt)
      .setAudience(this.audience)
      .setIssuer(this.issuer)
      .sign(this.signingKey.privateKey);

    return { token, jti, expiresAt };
  }

  /**
   * Throws `UnauthorizedException` for every rejection case (S-01..S-05):
   * `alg: none`, `HS256`, wrong signing key, expired, or a tampered claim
   * (which is simply a signature mismatch once any byte of the payload
   * changes). `algorithms: ['EdDSA']` is the explicit allowlist PR-089
   * requires — jose refuses to even attempt verification with a header
   * `alg` outside it, regardless of what key is supplied.
   */
  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => this.resolveVerificationKey(header.kid),
        {
          algorithms: ['EdDSA'],
          issuer: this.issuer,
          audience: this.audience,
        },
      );
      return payload as unknown as AccessTokenClaims;
    } catch {
      throw new UnauthorizedException({
        type: '/errors/unauthenticated',
        title: 'Unauthenticated',
        status: 401,
        detail: 'Access token is missing, malformed, expired or invalid.',
      });
    }
  }
}
