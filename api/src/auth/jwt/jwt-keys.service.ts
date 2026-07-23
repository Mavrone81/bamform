import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { exportJWK } from 'jose';
import type { JwksResponse } from '@bamform/shared';
import type { SigningKey } from './access-token.types';

/**
 * Ed25519 signing key + JWKS publication (PR-087). Deliberately independent
 * of Nest DI and file-mounted secrets so it is directly unit-testable with a
 * throwaway generated key — `JwtKeysModule` wires the production instance
 * from `JWT_SIGNING_KEY` (file-mounted, non-negotiable #9) + `JWT_KID_CURRENT`.
 *
 * Rotation with a 30-day overlap window (PR-087) is a manual ops procedure
 * (SECURITY_ARCHITECTURE.md §7.1) that requires a *second* Docker secret
 * (`JWT_SIGNING_KEY_PREVIOUS`) neither `docker-compose.yml` nor
 * `.env.example` currently provision — out of this slice's constraints
 * (must not alter docker-compose.yml topology). `resolveVerificationKey`
 * is written against a `Map` so wiring a previous key in later is additive,
 * not a redesign.
 */
export class JwtKeysService {
  readonly signingKey: SigningKey;
  private readonly verificationKeys: Map<string, KeyObject>;

  constructor(privateKeyPem: Buffer, kid: string) {
    const privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `JWT signing key must be Ed25519, got "${privateKey.asymmetricKeyType}" (PR-083)`,
      );
    }
    this.signingKey = { kid, privateKey };

    const publicKey = createPublicKey(privateKey);
    this.verificationKeys = new Map([[kid, publicKey]]);
  }

  resolveVerificationKey(kid: string | undefined): KeyObject {
    const key = kid && this.verificationKeys.get(kid);
    if (!key) {
      throw new Error(`unknown kid: ${String(kid)}`);
    }
    return key;
  }

  async getJwks(): Promise<JwksResponse> {
    const keys = await Promise.all(
      [...this.verificationKeys.entries()].map(async ([kid, key]) => ({
        ...(await exportJWK(key)),
        kid,
      })),
    );
    return { keys } as JwksResponse;
  }
}
