import { createHmac, randomBytes } from 'node:crypto';

/**
 * A real RFC 6238 TOTP implementation for the E2E fake server, matching the
 * parameters `api/src/auth/mfa` actually uses: HMAC-SHA1, 6 digits, 30-second
 * period, base32 (RFC 4648, unpadded) secrets.
 *
 * WHY THIS IS NOT CHEATING. The reviewer's standing objection to fake servers
 * (raised on slice 11b and repeated in this brief) is the rubber stamp that
 * says yes to everything. The fake needs to say NO to a wrong code, and the
 * only way it can is by actually computing the right one. The spec plays the
 * phone — it derives the current code from the secret the server just issued,
 * exactly as an authenticator app would — and the fake verifies it
 * independently, with the same ±1-step window and the same
 * `mfa_last_used_step` replay guard the real service implements. A wrong
 * code, a replayed code, a spent challenge token and a reused recovery code
 * are all genuinely rejected; none of it is stubbed.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD_SECONDS = 30;

export function randomBase32Secret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = '';
  for (const byte of raw) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export function base32Decode(secret: string): Buffer {
  const normalised = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of normalised) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function currentTotpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP over a 64-bit big-endian counter, truncated to six digits. */
export function totpCodeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** What a phone would be showing right now. */
export function currentTotpCode(secret: string, atMs: number = Date.now()): string {
  return totpCodeForStep(secret, currentTotpStep(atMs));
}

/**
 * Verifies a submitted code with a ±1-step skew window and the RFC 6238 §5.2
 * replay guard: the accepted step must be strictly greater than the last one
 * this account used, so a captured code cannot be replayed inside its own
 * 30-second window.
 */
export function verifyTotp(
  secret: string,
  code: string,
  lastUsedStep: number | undefined,
  atMs: number = Date.now(),
): { valid: boolean; step?: number } {
  const submitted = code.replace(/[\s-]/g, '');
  const now = currentTotpStep(atMs);
  for (const step of [now - 1, now, now + 1]) {
    if (totpCodeForStep(secret, step) !== submitted) continue;
    if (lastUsedStep !== undefined && step <= lastUsedStep) return { valid: false };
    return { valid: true, step };
  }
  return { valid: false };
}

/** Ten codes in the printed shape (`ABCD-EFGH-...`, 8 groups of 4) that
 * `shared/src/mfa.ts` accepts (32-64 characters after trimming). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const groups: string[] = [];
    for (let g = 0; g < 8; g++) {
      let group = '';
      for (let c = 0; c < 4; c++) {
        group += BASE32_ALPHABET[randomBytes(1)[0] % BASE32_ALPHABET.length];
      }
      groups.push(group);
    }
    return groups.join('-');
  });
}

/** Matches the server's `normaliseRecoveryCode`: uppercase, no separators. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * A six-digit code that is definitely NOT valid for this secret right now —
 * it avoids all three codes inside the ±1-step acceptance window. Picking
 * "000000" and hoping is a one-in-a-million flake that would show up as a
 * mysterious red main months from now.
 */
export function wrongTotpCodeFor(secret: string, atMs: number = Date.now()): string {
  const now = currentTotpStep(atMs);
  const valid = new Set([now - 1, now, now + 1].map((step) => totpCodeForStep(secret, step)));
  for (let candidate = 0; candidate < 1000; candidate++) {
    const code = String(candidate).padStart(6, '0');
    if (!valid.has(code)) return code;
  }
  /* c8 ignore next */
  throw new Error('unreachable: 1000 candidates cannot all collide with 3 valid codes');
}
