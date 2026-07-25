import type { AppUser, Role, UserRole } from '@prisma/client';
import type { RoleCode, User, UserStatus } from '@bamform/shared';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import type { FieldEncryptionService } from '../crypto/field-encryption';

export type UserRoleWithRole = UserRole & { role: Role };
export type AppUserWithRoles = AppUser & { userRoles: UserRoleWithRole[] };

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
