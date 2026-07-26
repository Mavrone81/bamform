import { randomBytes } from 'node:crypto';
import { computeRecoveryCodeBlindIndex } from '../crypto/blind-index';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  normaliseRecoveryCode,
} from './recovery-codes';

const KEY = randomBytes(32);

describe('U-MFA-05 recovery codes', () => {
  it('issues exactly 10 codes (brief §5)', () => {
    expect(generateRecoveryCodes()).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });

  it('every code carries at least 128 bits of entropy', () => {
    // 32 base32 characters x 5 bits = 160 bits, before the display hyphens.
    for (const code of generateRecoveryCodes()) {
      expect(normaliseRecoveryCode(code).length * 5).toBeGreaterThanOrEqual(128);
    }
  });

  it('issues distinct codes', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('two invocations do not repeat (CSPRNG, not seeded from anything stable)', () => {
    const first = new Set(generateRecoveryCodes());
    for (const code of generateRecoveryCodes()) {
      expect(first.has(code)).toBe(false);
    }
  });

  it('is displayed hyphen-grouped for hand transcription', () => {
    for (const code of generateRecoveryCodes()) {
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
    }
  });
});

describe('U-MFA-06 recovery-code normalisation', () => {
  it('uppercases, strips spaces and hyphens (brief §3)', () => {
    expect(normaliseRecoveryCode(' abcd-efgh  ijkl ')).toBe('ABCDEFGHIJKL');
  });

  it('applies NFC so a decomposed retype hashes to the same index', () => {
    // U+0041 U+030A (A + combining ring) normalises to U+00C5 under NFC.
    expect(normaliseRecoveryCode('Å')).toBe('Å');
  });

  it('a code and its own hyphen-stripped lowercase retype produce the SAME blind index', () => {
    const [code] = generateRecoveryCodes();
    const typedByHand = code.replace(/-/g, ' ').toLowerCase();
    expect(
      computeRecoveryCodeBlindIndex(code, KEY).equals(
        computeRecoveryCodeBlindIndex(typedByHand, KEY),
      ),
    ).toBe(true);
  });

  it('two different codes produce different blind indexes', () => {
    const [a, b] = generateRecoveryCodes();
    expect(
      computeRecoveryCodeBlindIndex(a, KEY).equals(computeRecoveryCodeBlindIndex(b, KEY)),
    ).toBe(false);
  });

  it('the same code under a different key produces a different blind index (keyed, not a bare hash)', () => {
    const [code] = generateRecoveryCodes();
    expect(
      computeRecoveryCodeBlindIndex(code, KEY).equals(
        computeRecoveryCodeBlindIndex(code, randomBytes(32)),
      ),
    ).toBe(false);
  });

  it('produces a 32-byte HMAC-SHA-256 digest, same primitive as email_bidx', () => {
    expect(computeRecoveryCodeBlindIndex(generateRecoveryCodes()[0], KEY)).toHaveLength(32);
  });
});
