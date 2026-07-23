import { createHmac } from 'node:crypto';

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
