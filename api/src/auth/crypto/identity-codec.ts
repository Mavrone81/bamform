import type { FieldContext, FieldEncryptionService } from '../../crypto/field-encryption';

/**
 * Real AES-256-GCM field encryption for `app_user`'s personal columns
 * (`full_name_ct`, `email_ct`, `employee_id_ct` — DATABASE_DESIGN.md §6.2,
 * PRD PR-106/107). Replaces slice 2's TEMPORARY plaintext passthrough codec
 * (`git log` this file to see it) at its single call site set:
 * `current-user.builder.ts` (decode, for `/auth/login`, `/auth/refresh`, `/auth/me` —
 * `api/openapi.yaml`'s `CurrentUser.fullName`/`.email`) and the auth integration test
 * fixture that seeds a loginable user (encode).
 *
 * Deliberately a thin `app_user`-scoped adapter over `../../crypto/field-encryption.ts`
 * (the general, reusable crypto primitive — AAD binding, envelope DEK, nonce
 * handling all live there) rather than the primitive itself, so:
 *   1. every auth read of these columns keeps going through ONE module (this file),
 *      matching the doc-comment convention slice 2 established, and
 *   2. any other table gaining a personal column later reuses `field-encryption.ts`
 *      directly instead of copying this file.
 */
export interface IdentityFieldContext {
  readonly column: 'full_name_ct' | 'email_ct' | 'employee_id_ct';
  readonly rowId: string;
}

const TABLE = 'app_user';

export function encodeIdentityField(
  plaintext: string,
  context: IdentityFieldContext,
  fieldEncryption: FieldEncryptionService,
): { ciphertext: Buffer; dekVersion: number } {
  return fieldEncryption.encrypt(plaintext, toFieldContext(context));
}

export function decodeIdentityField(
  stored: Uint8Array,
  dekVersion: number,
  context: IdentityFieldContext,
  fieldEncryption: FieldEncryptionService,
): string {
  return fieldEncryption.decrypt(stored, dekVersion, toFieldContext(context));
}

function toFieldContext(context: IdentityFieldContext): FieldContext {
  return { table: TABLE, column: context.column, rowId: context.rowId };
}
