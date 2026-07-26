import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (over RFC 4226 HOTP), HMAC-SHA1, 6 digits, 30-second step —
 * slice-13-mfa brief §5. SHA-1 is the RFC default and the only algorithm
 * every authenticator app supports universally; it is used here purely as an
 * HMAC PRF over a 160-bit secret, where SHA-1's collision weakness does not
 * apply (NIST SP 800-131A still permits HMAC-SHA-1).
 *
 * ## Why hand-rolled rather than `otplib`
 *
 * The brief prefers a maintained package "over hand-rolling HOTP", and
 * permits hand-rolling with justification plus the RFC 6238 Appendix B
 * vectors as a test. The justification, weighed honestly:
 *
 *  - The whole primitive is ~25 lines of HMAC + big-endian counter +
 *    dynamic truncation, and `totp.spec.ts` asserts all six published
 *    Appendix B vectors verbatim, in both 8- and 6-digit form. That is
 *    stronger evidence of correctness than "a popular package is popular".
 *  - Adding `otplib` means regenerating `package-lock.json`. This repo's
 *    lockfile is a live CI hazard (slice 12 lost three runs to it; the
 *    default `npm` on the build machine is v11 and drops optional platform
 *    bindings) and it pulls a transitive tree into the Trivy/`npm audit`
 *    gates in job 6 for one function.
 *  - There is no ongoing maintenance burden: RFC 6238 is frozen.
 *
 * Recorded as a deviation in `.superpowers/sdd/slice-13-mfa-report.md`.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Clock-skew tolerance: accept t-1, t, t+1. Brief §5 — "No wider." */
export const TOTP_WINDOW_STEPS = 1;
/** 160-bit CSPRNG secret (brief §5), also RFC 4226 §4 R6's recommended size. */
export const TOTP_SECRET_BYTES = 20;

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** The RFC 6238 time counter T = floor(unixSeconds / X), X = 30. */
export function totpStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / TOTP_PERIOD_SECONDS);
}

export function currentTotpStep(now: Date = new Date()): number {
  return totpStep(Math.floor(now.getTime() / 1000));
}

/**
 * RFC 4226 §5.3 dynamic truncation applied to the RFC 6238 time counter.
 * `step` is written as an unsigned 64-bit big-endian counter — hence
 * `BigInt`, not a 32-bit `writeUInt32BE` pair, so the Appendix B vector at
 * T=20000000000 (beyond 2^32 seconds) is computed correctly rather than
 * wrapping.
 */
export function totpCode(secret: Uint8Array, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface TotpVerification {
  valid: boolean;
  /** The time step the presented code matched — persisted as the replay high-water mark. */
  step?: number;
}

/**
 * Verifies `presented` against the ±1-step window around `currentStep`.
 *
 * `notBeforeStep` is the RFC 6238 §5.2 replay guard: "the verifier MUST NOT
 * accept the second OTP after the successful validation" within the same
 * time step. The caller persists the accepted step in
 * `app_user.mfa_last_used_step` and passes it back here, so a captured code
 * cannot be replayed inside its own 30-second window — and neither can any
 * earlier step still inside the skew window.
 *
 * Comparison is `timingSafeEqual` over the candidate codes. A 6-digit code
 * is only ~20 bits, so a timing oracle is not the dominant attack (the
 * lockout counter is what actually bounds guessing), but a constant-time
 * compare costs nothing and removes the question.
 */
export function verifyTotp(
  secret: Uint8Array,
  presented: string,
  currentStep: number,
  notBeforeStep?: number | null,
  digits: number = TOTP_DIGITS,
): TotpVerification {
  const normalised = presented.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalised)) {
    return { valid: false };
  }
  const presentedBuffer = Buffer.from(normalised, 'ascii');

  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = currentStep + offset;
    if (step < 0) {
      continue;
    }
    if (notBeforeStep !== undefined && notBeforeStep !== null && step <= notBeforeStep) {
      continue;
    }
    const candidate = Buffer.from(totpCode(secret, step, digits), 'ascii');
    if (timingSafeEqual(candidate, presentedBuffer)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

/**
 * `otpauth://totp/BamForm:<email>?secret=…&issuer=BamForm&algorithm=SHA1&digits=6&period=30`
 * (brief §5). The QR image is rendered client-side in slice 13-UI — the api
 * deliberately takes on no QR/image dependency.
 */
export function buildOtpauthUri(params: {
  issuer: string;
  accountName: string;
  base32Secret: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.base32Secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
