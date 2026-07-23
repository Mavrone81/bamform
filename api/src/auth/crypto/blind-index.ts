import { createHmac } from 'node:crypto';

/**
 * `app_user.email_bidx` — HMAC-SHA-256 over the normalised email, keyed by
 * `BLIND_INDEX_KEY` (SECURITY_ARCHITECTURE.md §6/§8, DATABASE_DESIGN.md
 * §6.2). This is the ONLY piece of field-encryption infrastructure this
 * slice implements — it exists purely so login can look a user up by the
 * schema's existing `email_bidx` unique index (PR-084/PR-090 need a working
 * login; the index is already migrated in slice 1). `AES-256-GCM` encryption
 * of `email_ct`/`full_name_ct` themselves (PR-106/107, envelope KEK/DEK) is
 * NOT implemented here — that remains slice 3 scope. See
 * `identity-codec.ts` for how those columns are read in the meantime.
 *
 * Deterministic (unlike AES-GCM, which must never be used for equality
 * lookup — a fresh nonce makes identical plaintexts produce different
 * ciphertext). Email is lowercased and trimmed before hashing so lookup is
 * case-insensitive and whitespace-tolerant, matching how `/auth/login`
 * accepts an email.
 */
export function computeEmailBlindIndex(email: string, blindIndexKey: Buffer): Buffer {
  const normalised = email.trim().toLowerCase();
  return createHmac('sha256', blindIndexKey).update(normalised, 'utf8').digest();
}
