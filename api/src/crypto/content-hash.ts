import { createHash } from 'node:crypto';
import { canonicalSerialise, type CanonicalValue } from './canonical-serialiser';

/**
 * PR-093 / PR-SEC-13: SHA-256 over the canonical serialisation of a record. This is
 * what `approval_step.content_hash` stores and what `record-signer.ts` signs.
 *
 * Kept as a one-line composition, deliberately separate from
 * `canonical-serialiser.ts` (which must stay free of even `node:crypto`) so the pure
 * serialisation function can never be affected by anything but its own logic.
 */
export function computeContentHash(record: CanonicalValue): Buffer {
  return createHash('sha256').update(canonicalSerialise(record)).digest();
}
