import type { CurrentUser } from '@bamform/shared';
import type { Prisma } from '@prisma/client';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { decodeIdentityField } from './crypto/identity-codec';

/**
 * Builds the `CurrentUser` shape (`api/openapi.yaml`) for `/auth/login`,
 * `/auth/refresh` and `/auth/me`. Takes `Prisma.TransactionClient` rather
 * than `PrismaService` so callers can build it either standalone (`/auth/me`)
 * or inside the same transaction as a login/refresh (`PrismaService`
 * satisfies this type structurally).
 *
 * `fieldEncryption` decrypts `full_name_ct`/`email_ct` (PR-106) — the single call
 * site slice 3 replaced (see `crypto/identity-codec.ts`).
 */
export async function buildCurrentUser(
  prisma: Prisma.TransactionClient,
  userId: string,
  stepUpWindowSeconds: number,
  fieldEncryption: FieldEncryptionService,
): Promise<CurrentUser> {
  const user = await prisma.appUser.findUniqueOrThrow({
    where: { id: userId },
    include: {
      // Slice 13a: `active: false` is how `PATCH /users/{id}` revokes a
      // role without a `DELETE` (INV-16) — excluded so `/auth/me` and the
      // sync bootstrap never report a revoked role as held.
      userRoles: { where: { active: true }, include: { role: true } },
      userAreaScopes: true,
    },
  });

  const now = new Date();
  const delegations = await prisma.delegation.findMany({
    where: {
      delegateId: userId,
      revokedAt: null,
      validFrom: { lte: now },
      validTo: { gte: now },
    },
    include: { delegator: true },
  });

  const stepUpValidUntil = user.lastAuthenticatedAt
    ? new Date(user.lastAuthenticatedAt.getTime() + stepUpWindowSeconds * 1000).toISOString()
    : null;

  return {
    id: user.id,
    fullName: decodeIdentityField(
      user.fullNameCt,
      user.dekVersion,
      { column: 'full_name_ct', rowId: user.id },
      fieldEncryption,
    ),
    email: decodeIdentityField(
      user.emailCt,
      user.dekVersion,
      { column: 'email_ct', rowId: user.id },
      fieldEncryption,
    ),
    roles: user.userRoles.map((userRole) => userRole.role.code),
    areaScope: user.userAreaScopes.map((scope) => scope.areaId),
    activeDelegations: delegations.map((delegation) => ({
      delegatorId: delegation.delegatorId,
      delegatorName: decodeIdentityField(
        delegation.delegator.fullNameCt,
        delegation.delegator.dekVersion,
        { column: 'full_name_ct', rowId: delegation.delegator.id },
        fieldEncryption,
      ),
      validTo: delegation.validTo.toISOString(),
    })),
    stepUpValidUntil,
  };
}
