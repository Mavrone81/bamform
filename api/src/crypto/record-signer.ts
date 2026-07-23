import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * PR-094 / PR-SEC-07: Ed25519 signing over a record's content hash
 * (`content-hash.ts` → `computeContentHash`). Deliberately independent of Nest DI and
 * file-mounted secrets, mirroring `../auth/jwt/jwt-keys.service.ts` — directly
 * unit-testable with a throwaway generated key. `CryptoModule` wires the production
 * instance from the file-mounted `RECORD_SIGNING_KEY` secret (non-negotiable #9) and
 * `RECORD_SIGNING_KID`.
 *
 * `RECORD_SIGNING_KEY` is a DISTINCT key from `JWT_SIGNING_KEY` (SEC §6, PR-SEC-07):
 * this class only ever touches the record-signing key, never the token key.
 *
 * Ed25519 signs the message directly (no separate digest step in the algorithm
 * itself) — `crypto.sign(null, data, key)` / `crypto.verify(null, data, key, sig)` is
 * Node's documented one-shot form for EdDSA, where `data` here is the ALREADY-COMPUTED
 * SHA-256 content hash (PR-093), not the raw record.
 */
export class RecordSigningService {
  readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(privateKeyPem: Buffer, kid: string) {
    const privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `Record signing key must be Ed25519, got "${privateKey.asymmetricKeyType}" (PR-094)`,
      );
    }
    this.privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey);
    this.kid = kid;
  }

  /** Signs a content hash (typically `computeContentHash(record)`), for `approval_step.signature`. */
  sign(contentHash: Buffer): Buffer {
    return sign(null, contentHash, this.privateKey);
  }

  /**
   * Verifies a signature against a content hash. `publicKey` defaults to this
   * service's own key so callers verifying THEIR OWN freshly-signed record don't need
   * to supply anything; `GET /records/{id}/integrity` (slice 7) will resolve the
   * correct historical public key by `kid` and pass it explicitly instead, since a
   * record signed under a rotated-out key must still verify (PR-SEC-09).
   */
  verify(contentHash: Buffer, signature: Buffer, publicKey: KeyObject = this.publicKey): boolean {
    return verify(null, contentHash, publicKey, signature);
  }

  getPublicKey(): KeyObject {
    return this.publicKey;
  }
}
