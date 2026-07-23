import { timingSafeEqual } from 'node:crypto';
import { FieldEncryptionService } from './field-encryption';
import { unwrapDek } from './key-wrapping';

/**
 * Pure construction logic for `FieldEncryptionService`, factored out of
 * `crypto.module.ts` so it is directly unit-testable without booting Nest or touching
 * the filesystem (`crypto.module.ts`'s job is only to read the secret files and hand
 * the raw buffers here).
 *
 * PR-SEC-08 / U-ENC-07: `BLIND_INDEX_KEY` must be distinct from the DEK — if they were
 * the same key, an attacker holding only the blind-index key could confirm the
 * presence of a known email by recomputing the HMAC, AND (if it were also the DEK)
 * decrypt every ciphertext outright. This is asserted at startup, not merely
 * documented: `CryptoModule` cannot finish constructing `FIELD_ENCRYPTION_SERVICE`
 * with a DEK equal to the blind index key.
 */
export function buildFieldEncryptionService(params: {
  kek: Buffer;
  wrappedDek: Buffer;
  currentDekVersion: number;
  blindIndexKey: Buffer;
}): FieldEncryptionService {
  const dek = unwrapDek(params.wrappedDek, params.kek);
  assertDistinctKeys(dek, params.blindIndexKey);
  return new FieldEncryptionService(
    new Map([[params.currentDekVersion, dek]]),
    params.currentDekVersion,
  );
}

function assertDistinctKeys(dek: Buffer, blindIndexKey: Buffer): void {
  const equal = dek.length === blindIndexKey.length && timingSafeEqual(dek, blindIndexKey);
  if (equal) {
    throw new Error(
      'BLIND_INDEX_KEY must be distinct from the DEK (SEC §6 PR-SEC-08) — refusing to start',
    );
  }
}
