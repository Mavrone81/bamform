import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * PR-107: envelope encryption. Wraps/unwraps the single application DEK under the KEK,
 * both AES-256-GCM. This is the "cheapest rotation in the hierarchy" (SEC §7.3) —
 * re-wrapping under a new KEK never touches the DEK or any encrypted row.
 *
 * Storage layout for the wrapped value (SEC does not specify a byte layout for
 * `DEK_WRAPPED`; this is the documented choice — see `field-encryption.ts` for the
 * matching choice on row ciphertext): a single buffer of
 * `nonce (12 bytes) || ciphertext (32 bytes) || authTag (16 bytes)`, base64-encoded at
 * rest in the `dek_wrapped` secret file (matches `ENVIRONMENT_REQUIREMENTS.md` §4.5:
 * `DEK_WRAPPED` is `base64`).
 *
 * No AAD is bound to the wrap operation: unlike a personal-data row (which has a table,
 * column and primary key to bind to), the DEK is a single, unique, non-relational
 * secret — there is no second context to bind against, and the KEK/DEK relationship is
 * already 1:1 per version.
 */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function wrapDek(dek: Buffer, kek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

export function unwrapDek(wrapped: Buffer, kek: Buffer): Buffer {
  if (wrapped.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error('Wrapped DEK is too short to contain a nonce, ciphertext and auth tag');
  }
  const nonce = wrapped.subarray(0, NONCE_BYTES);
  const tag = wrapped.subarray(wrapped.length - TAG_BYTES);
  const ciphertext = wrapped.subarray(NONCE_BYTES, wrapped.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
