/**
 * RFC 4648 §6 base32 ("standard" alphabet), no padding — the encoding every
 * authenticator app expects for the `secret=` parameter of an `otpauth://`
 * URI (slice-13-mfa brief §5).
 *
 * Hand-rolled rather than pulled from npm because Node has no built-in
 * base32 and this is 30 lines of bit-shifting with published test vectors
 * (`base32.spec.ts` asserts RFC 4648 §10 verbatim). Adding a dependency for
 * it would buy no correctness the vectors don't already prove, and slice 12
 * lost three CI runs to one careless dependency addition (brief §5).
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Reverse lookup, built once. `undefined` for any character outside the alphabet. */
const DECODE_TABLE: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((character, index) => [character, index]),
);

export function base32Encode(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Accepts lowercase, `=` padding and whitespace/hyphen separators, because a
 * user may retype a secret or a recovery code by hand from a printed sheet.
 * Any other character is a hard error — silently skipping it would decode to
 * a *different* secret than the one displayed.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of cleaned) {
    const index = DECODE_TABLE.get(character);
    if (index === undefined) {
      throw new Error(`Invalid base32 character: not in the RFC 4648 alphabet`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
