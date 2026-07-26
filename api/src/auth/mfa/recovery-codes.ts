import { randomBytes } from 'node:crypto';
import { base32Encode } from './base32';

/** Brief §5 (D-3): ten single-use codes, issued once at enrolment. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * 20 bytes = 160 bits, encoding to exactly 32 base32 characters (20 x 8 / 5),
 * which groups evenly into 8 blocks of 4 for hand transcription. Comfortably
 * above the >= 128 bits the brief requires — the entropy is what makes a
 * keyed digest (rather than Argon2id) the right storage primitive; see
 * `computeRecoveryCodeBlindIndex`.
 */
const RECOVERY_CODE_BYTES = 20;
const GROUP_SIZE = 4;

/**
 * Codes are returned in plaintext exactly once, in the
 * `POST /auth/mfa/enrol/confirm` response, and never again — only the keyed
 * blind index is stored. Never log the return value of this function.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES));
    return (raw.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')) ?? []).join('-');
  });
}

/**
 * Brief §3: "`normalise` = uppercase, strip spaces/hyphens, NFC." Applied
 * identically at issue-time (when the blind index is computed and stored)
 * and at redeem-time, so a user retyping `abcd efgh …` from a printed sheet
 * still matches the stored row.
 *
 * NFC first, then case-fold: composing before uppercasing is the order that
 * keeps a decomposed retype equal to its composed original.
 */
export function normaliseRecoveryCode(code: string): string {
  return code.normalize('NFC').replace(/[\s-]/g, '').toUpperCase();
}
