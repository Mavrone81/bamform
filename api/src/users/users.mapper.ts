import { createHash } from 'node:crypto';
import type { AppUser, Role, UserAreaScope, UserRole } from '@prisma/client';
import type { RoleCode, User, UserStatus } from '@bamform/shared';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import type { FieldEncryptionService } from '../crypto/field-encryption';

export type UserRoleWithRole = UserRole & { role: Role };
export type AppUserWithRoles = AppUser & {
  userRoles: UserRoleWithRole[];
  /** Filtered to `active: true` BEFORE this mapper runs — same contract as `userRoles`. */
  userAreaScopes: UserAreaScope[];
};

const STATUS_FROM_DB: Record<string, UserStatus> = {
  active: 'ACTIVE',
  suspended: 'SUSPENDED',
  deactivated: 'DEACTIVATED',
};

/**
 * `PATCH /users/{id}`'s `roles` DTO field is filtered to `active: true` rows
 * BEFORE this runs (`users.service.ts`'s reads) — this mapper does not
 * re-filter, so it must never be handed a raw, unfiltered `userRoles` array.
 */
export function toUser(row: AppUserWithRoles, fieldEncryption: FieldEncryptionService): User {
  return {
    id: row.id,
    employeeId: row.employeeIdCt
      ? decodeIdentityField(
          row.employeeIdCt,
          row.dekVersion,
          { column: 'employee_id_ct', rowId: row.id },
          fieldEncryption,
        )
      : null,
    fullName: decodeIdentityField(
      row.fullNameCt,
      row.dekVersion,
      { column: 'full_name_ct', rowId: row.id },
      fieldEncryption,
    ),
    email: decodeIdentityField(
      row.emailCt,
      row.dekVersion,
      { column: 'email_ct', rowId: row.id },
      fieldEncryption,
    ),
    status: STATUS_FROM_DB[row.status],
    active: row.status === 'active',
    roles: row.userRoles.map((userRole) => userRole.role.code as RoleCode),
    // Slice 13-UI-B (SYS-10): ACTIVE scopes only (pre-filtered, like
    // `userRoles`). `[]` = unrestricted, mirroring PR-API-10's read side.
    areaIds: row.userAreaScopes.map((scope) => scope.areaId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function ctSha256(bytes: Uint8Array | null | undefined): string | null {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}

/**
 * CR-5 (crypto-review-2026-07-27) / PR-SEC-02 — the audit-payload projection
 * of a user row. `audit_event.before`/`after` are append-only JSON with
 * 7-year retention and no deletion path, so decrypted names/emails written
 * there would be a PERMANENT plaintext copy that defeats the field
 * encryption entirely (`toUser` above decrypts — it exists for API
 * responses, never for audit payloads).
 *
 * PR-SEC-02: "Where an audit diff concerns an encrypted column, it records
 * that the field changed and its ciphertext digest, not the value" — hence
 * SHA-256 digests of the CIPHERTEXT columns: an auditor can see that/which
 * fields changed (digest differs) without the payload holding any personal
 * data, and the digest is of AEAD ciphertext so it is not brute-forceable
 * the way a digest of a low-entropy plaintext (an email) would be.
 */
export function toUserAuditView(row: AppUserWithRoles): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    active: row.status === 'active',
    roles: row.userRoles
      .filter((userRole) => userRole.active)
      .map((userRole) => userRole.role.code),
    mustChangePassword: row.mustChangePassword,
    dekVersion: row.dekVersion,
    fullNameCtSha256: ctSha256(row.fullNameCt),
    emailCtSha256: ctSha256(row.emailCt),
    employeeIdCtSha256: ctSha256(row.employeeIdCt),
  };
}
