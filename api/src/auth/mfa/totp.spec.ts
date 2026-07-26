import { generateTotpSecret, totpCode, totpStep, verifyTotp } from './totp';

/**
 * U-MFA-02 — RFC 6238 Appendix B test vectors, the ground truth for this
 * implementation (slice-13-mfa brief §5: "this is the one place where 'our
 * own tests pass' is not evidence of correctness").
 *
 * The published seed for the HMAC-SHA1 vectors is the ASCII string
 * "12345678901234567890" (20 bytes / 160 bits — the same secret size
 * `generateTotpSecret()` issues). The published values are 8 digits; BamForm
 * issues 6, so `digits` is a parameter here purely so the RFC's own numbers
 * can be asserted verbatim rather than re-derived.
 */
const RFC6238_SHA1_SEED = Buffer.from('12345678901234567890', 'ascii');

describe('U-MFA-02 TOTP — RFC 6238 Appendix B vectors (HMAC-SHA1)', () => {
  const VECTORS: ReadonlyArray<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(VECTORS)('T=%p produces the 8-digit code %p', (unixSeconds, expected) => {
    expect(totpCode(RFC6238_SHA1_SEED, totpStep(unixSeconds), 8)).toBe(expected);
  });

  it.each(VECTORS)(
    'T=%p 6-digit code is the low 6 digits of the RFC value',
    (unixSeconds, rfc8) => {
      expect(totpCode(RFC6238_SHA1_SEED, totpStep(unixSeconds))).toBe(rfc8.slice(-6));
    },
  );

  it('uses a 30-second time step (RFC 6238 default X=30)', () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29)).toBe(0);
    expect(totpStep(30)).toBe(1);
    expect(totpStep(59)).toBe(1);
    expect(totpStep(1111111109)).toBe(37037036);
  });

  it('always emits exactly `digits` characters, zero-padded', () => {
    // T=1111111109 is 07081804 — a genuine leading-zero case from the RFC.
    expect(totpCode(RFC6238_SHA1_SEED, totpStep(1111111109), 8)).toHaveLength(8);
    expect(totpCode(RFC6238_SHA1_SEED, totpStep(1111111109), 8).startsWith('0')).toBe(true);
  });
});

describe('U-MFA-03 verifyTotp — ±1 step window and no wider', () => {
  const step = totpStep(1111111109);

  it('accepts the current step', () => {
    expect(verifyTotp(RFC6238_SHA1_SEED, totpCode(RFC6238_SHA1_SEED, step), step)).toEqual({
      valid: true,
      step,
    });
  });

  it('accepts t-1 and t+1 (clock skew tolerance)', () => {
    expect(verifyTotp(RFC6238_SHA1_SEED, totpCode(RFC6238_SHA1_SEED, step - 1), step)).toEqual({
      valid: true,
      step: step - 1,
    });
    expect(verifyTotp(RFC6238_SHA1_SEED, totpCode(RFC6238_SHA1_SEED, step + 1), step)).toEqual({
      valid: true,
      step: step + 1,
    });
  });

  it('rejects t-2 and t+2 — the window is ±1, not wider', () => {
    expect(verifyTotp(RFC6238_SHA1_SEED, totpCode(RFC6238_SHA1_SEED, step - 2), step).valid).toBe(
      false,
    );
    expect(verifyTotp(RFC6238_SHA1_SEED, totpCode(RFC6238_SHA1_SEED, step + 2), step).valid).toBe(
      false,
    );
  });

  it('rejects a code that is not 6 digits, without evaluating HMAC', () => {
    expect(verifyTotp(RFC6238_SHA1_SEED, '12345', step).valid).toBe(false);
    expect(verifyTotp(RFC6238_SHA1_SEED, '1234567', step).valid).toBe(false);
    expect(verifyTotp(RFC6238_SHA1_SEED, 'abcdef', step).valid).toBe(false);
    expect(verifyTotp(RFC6238_SHA1_SEED, '', step).valid).toBe(false);
  });

  it('tolerates a space-separated code as typed from an authenticator app', () => {
    const code = totpCode(RFC6238_SHA1_SEED, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(RFC6238_SHA1_SEED, spaced, step).valid).toBe(true);
  });

  it('rejects every step at or below `notBeforeStep` (RFC 6238 §5.2 replay guard)', () => {
    // A code already accepted at `step` must not be accepted again inside
    // its own 30 s window — this is the guard `mfa_last_used_step` persists.
    const code = totpCode(RFC6238_SHA1_SEED, step);
    expect(verifyTotp(RFC6238_SHA1_SEED, code, step).valid).toBe(true);
    expect(verifyTotp(RFC6238_SHA1_SEED, code, step, step).valid).toBe(false);
    // ...and the still-in-window t+1 code is unaffected.
    expect(
      verifyTotp(RFC6238_SHA1_SEED, totpCode(RFC6238_SHA1_SEED, step + 1), step, step).valid,
    ).toBe(true);
  });
});

describe('U-MFA-04 generateTotpSecret', () => {
  it('issues a 160-bit secret (RFC 4226 §4 R6 recommends >= 128 bits)', () => {
    expect(generateTotpSecret().length).toBe(20);
  });

  it('is not deterministic (CSPRNG, not a counter or a derived value)', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a.equals(b)).toBe(false);
  });
});
