import { UnauthorizedException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import type { SigningKey, VerificationKeyResolver } from '../jwt/access-token.types';

/**
 * The audience that separates an MFA challenge token from an access token.
 * `AccessTokenService.verify` pins `audience: JWT_AUDIENCE` ("bamform-api"),
 * so a token minted here can never satisfy `JwtAuthGuard` — and this service
 * pins the reverse, so an access token can never stand in for a challenge.
 * Asserted both ways in `mfa-challenge-token.service.spec.ts` (S-35).
 */
export const MFA_CHALLENGE_AUDIENCE = 'bamform-mfa-challenge';

/** Brief §4.2: short-lived, 5 minutes. */
export const MFA_CHALLENGE_TTL_SECONDS = 300;

const MFA_CHALLENGE_TYP = 'mfa-challenge+jwt';

export interface MfaChallengeClaims {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  aud: string;
  iss: string;
}

export interface SignedMfaChallenge {
  token: string;
  jti: string;
  expiresIn: number;
  expiresAt: number; // epoch seconds
}

/**
 * The intermediate credential issued by `POST /auth/login` when the password
 * succeeded but the account still owes a second factor (brief §4).
 *
 * It is signed with the SAME Ed25519 signing key as the access token — one
 * key, one JWKS, one rotation story (PR-087) — and separated from it purely
 * by `aud` + `typ`. It deliberately carries NO `roles` claim: it authorises
 * only `/auth/mfa/*`, and it does so by being accepted only by
 * `JwtAuthGuard`'s explicit `@MfaChallengeAuth()` branch, never by the
 * default access-token path.
 *
 * Single use is enforced OUTSIDE this class, by denylisting `jti` in Redis
 * (`TokenDenylistService`, the same mechanism PR-088 uses for logged-out
 * access tokens) the moment a challenge is redeemed — brief §4: "Expired/
 * replayed challenge token -> 401".
 *
 * Mirrors `AccessTokenService`'s deliberate independence from Nest DI so the
 * security tests can construct it directly with throwaway keys.
 */
export class MfaChallengeTokenService {
  constructor(
    private readonly signingKey: SigningKey,
    private readonly resolveVerificationKey: VerificationKeyResolver,
    private readonly issuer: string,
    private readonly ttlSeconds: number = MFA_CHALLENGE_TTL_SECONDS,
  ) {}

  async sign(userId: string): Promise<SignedMfaChallenge> {
    const jti = uuidv7();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + this.ttlSeconds;

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: this.signingKey.kid, typ: MFA_CHALLENGE_TYP })
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAt)
      .setAudience(MFA_CHALLENGE_AUDIENCE)
      .setIssuer(this.issuer)
      .sign(this.signingKey.privateKey);

    return { token, jti, expiresIn: this.ttlSeconds, expiresAt };
  }

  /**
   * Throws `UnauthorizedException` for every rejection — expired, wrong key,
   * wrong audience (i.e. an access token presented here), wrong `typ`, or
   * `alg` outside the EdDSA allowlist (PR-089). The caller must not
   * distinguish these to the client: brief §4 requires that a wrong
   * challenge token and a wrong TOTP code look identical.
   */
  async verify(token: string): Promise<MfaChallengeClaims> {
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => this.resolveVerificationKey(header.kid),
        {
          algorithms: ['EdDSA'],
          issuer: this.issuer,
          audience: MFA_CHALLENGE_AUDIENCE,
          typ: MFA_CHALLENGE_TYP,
        },
      );
      if (protectedHeader.typ !== MFA_CHALLENGE_TYP) {
        throw new Error('unexpected typ');
      }
      return payload as unknown as MfaChallengeClaims;
    } catch {
      throw new UnauthorizedException({
        type: '/errors/unauthenticated',
        title: 'Unauthenticated',
        status: 401,
        detail: 'MFA challenge is missing, expired or invalid.',
      });
    }
  }
}
