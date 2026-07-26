import { createHmac } from 'node:crypto';
import { normaliseRecoveryCode } from '../mfa/recovery-codes';

/**
 * `app_user.email_bidx` / `app_user.employee_id_bidx` — HMAC-SHA-256 keyed by
 * `BLIND_INDEX_KEY` (SECURITY_ARCHITECTURE.md §6/§8, DATABASE_DESIGN.md §6.2,
 * PR-108). Slice 2 stood up email-only lookup (needed for `/auth/login`, PR-084/
 * PR-090); slice 3 finalises this — same key, extended to `employee_id` per the
 * brief's DBD-referenced deliverable — without introducing a second key or a
 * duplicate implementation.
 *
 * Deterministic (unlike AES-GCM, which must never be used for equality lookup — a
 * fresh nonce makes identical plaintexts produce different ciphertext). Real
 * AES-256-GCM encryption of `email_ct`/`full_name_ct`/`employee_id_ct` themselves is
 * `../../crypto/field-encryption.ts` (PR-106/107) — this module is ONLY the blind
 * index, kept in `auth/crypto` (rather than moved into `../../crypto`) because its
 * sole consumer today is still `AuthService.login`.
 */
function computeBlindIndex(normalisedValue: string, blindIndexKey: Buffer): Buffer {
  return createHmac('sha256', blindIndexKey).update(normalisedValue, 'utf8').digest();
}

/**
 * Email is lowercased and trimmed before hashing so lookup is case-insensitive and
 * whitespace-tolerant, matching how `/auth/login` accepts an email.
 */
export function computeEmailBlindIndex(email: string, blindIndexKey: Buffer): Buffer {
  return computeBlindIndex(email.trim().toLowerCase(), blindIndexKey);
}

/**
 * Employee IDs are trimmed only, NOT case-folded — DBD does not document them as
 * case-insensitive codes the way email addresses are, and folding case on an
 * alphanumeric identifier (unlike a domain-name-derived email local part) risks
 * silently merging two distinct real-world codes. If a future employee-ID lookup
 * flow needs case-insensitivity, that is a deliberate decision for that slice, not
 * an accidental side effect of reusing this function.
 */
export function computeEmployeeIdBlindIndex(employeeId: string, blindIndexKey: Buffer): Buffer {
  return computeBlindIndex(employeeId.trim(), blindIndexKey);
}

/**
 * Slice 13-MFA — `mfa_recovery_code.code_bidx`. Deliberately the SAME keyed
 * HMAC-SHA-256 primitive as `email_bidx`, not Argon2id, and that choice is
 * load-bearing rather than lazy:
 *
 *  - A recovery code is 160 bits of CSPRNG output (`mfa/recovery-codes.ts`).
 *    Argon2id's entire value is defeating dictionary/brute-force attacks on
 *    LOW-entropy secrets; against a 160-bit random string there is nothing
 *    to dictionary-attack, so the memory-hard KDF buys no security here.
 *  - It costs real availability: verifying an Argon2id hash requires trying
 *    the presented code against every candidate ROW (up to 10 per user, and
 *    with no index there is no way to narrow them), at 64 MiB and ~100 ms
 *    each, on a login-adjacent, unauthenticated-adjacent endpoint. That is a
 *    self-inflicted DoS vector. The keyed digest is an O(1) unique-index
 *    lookup.
 *  - The key is the file-mounted `BLIND_INDEX_KEY`, so a database-only
 *    compromise still cannot enumerate codes offline — the property Argon2id
 *    would otherwise be providing.
 *
 * `normalise` (uppercase / strip spaces+hyphens / NFC) lives with the code
 * format in `mfa/recovery-codes.ts#normaliseRecoveryCode` and MUST be applied
 * identically at issue and at redeem — it is applied here, once, so no call
 * site can forget it.
 */
export function computeRecoveryCodeBlindIndex(code: string, blindIndexKey: Buffer): Buffer {
  return computeBlindIndex(normaliseRecoveryCode(code), blindIndexKey);
}
