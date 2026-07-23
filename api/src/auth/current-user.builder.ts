import type { CurrentUser } from '@bamform/shared';
import type { Prisma } from '@prisma/client';
import { decodeIdentityField } from './crypto/identity-codec';

/**
 * Builds the `CurrentUser` shape (`api/openapi.yaml`) for `/auth/login`,
 * `/auth/refresh` and `/auth/me`. Takes `Prisma.TransactionClient` rather
 * than `PrismaService` so callers can build it either standalone (`/auth/me`)
 * or inside the same transaction as a login/refresh (`PrismaService`
 * satisfies this type structurally).
 */
export async function buildCurrentUser(
  prisma: Prisma.TransactionClient,
  userId: string,
  stepUpWindowSeconds: number,
): Promise<CurrentUser> {
  const user = await prisma.appUser.findUniqueOrThrow({
    where: { id: userId },
    include: {
      userRoles: { include: { role: true } },
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
    fullName: decodeIdentityField(user.fullNameCt),
    email: decodeIdentityField(user.emailCt),
    roles: user.userRoles.map((userRole) => userRole.role.code),
    areaScope: user.userAreaScopes.map((scope) => scope.areaId),
    activeDelegations: delegations.map((delegation) => ({
      delegatorId: delegation.delegatorId,
      delegatorName: decodeIdentityField(delegation.delegator.fullNameCt),
      validTo: delegation.validTo.toISOString(),
    })),
    stepUpValidUntil,
  };
}
