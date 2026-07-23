/**
 * TEMPORARY passthrough codec for `app_user.full_name_ct` / `email_ct`.
 *
 * DATABASE_DESIGN.md §6.2 and SECURITY_ARCHITECTURE.md §6 specify these
 * columns as AES-256-GCM ciphertext (PR-106/107, envelope KEK/DEK, PK as
 * AAD) — but that field-encryption pipeline is explicitly slice 3 scope
 * (BUILD_HANDOFF §3 row 3), sequenced AFTER this auth slice. Slice 1's own
 * integration fixtures already establish the accepted interim state
 * (`api/test/integration/helpers/fixtures.ts`: "Field encryption (PR-106)
 * does not exist yet (slice 3) — personal-data columns are filled with
 * placeholder bytes").
 *
 * The auth module cannot avoid reading these columns entirely — `POST
 * /auth/login` and `GET /auth/me` must return `CurrentUser.fullName`
 * (api/openapi.yaml, required field) — so this codec stores/reads them as
 * plain UTF-8 bytes until slice 3 replaces it with real AES-256-GCM
 * encrypt/decrypt. Every auth read of these columns MUST go through this
 * module (not `.toString('utf8')` ad hoc at call sites) so slice 3's change
 * is a one-file swap, not a hunt across the auth module.
 */
export function encodeIdentityField(plaintext: string): Buffer {
  return Buffer.from(plaintext, 'utf8');
}

export function decodeIdentityField(stored: Uint8Array): string {
  return Buffer.from(stored).toString('utf8');
}
