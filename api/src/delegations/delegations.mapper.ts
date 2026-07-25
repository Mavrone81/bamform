import type { Delegation as DelegationRow, AppUser } from '@prisma/client';
import type { Delegation } from '@bamform/shared';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import type { FieldEncryptionService } from '../crypto/field-encryption';

export type DelegationWithParties = DelegationRow & {
  delegator: AppUser;
  delegate: AppUser;
};

/**
 * `delegatorName`/`delegateName` decrypt `full_name_ct` — an already-accepted
 * read path (`api/src/auth/current-user.builder.ts#buildCurrentUser`'s
 * `activeDelegations[].delegatorName` does the same thing for the exact same
 * table/column), not a new precedent this slice invents.
 */
export function toDelegation(
  row: DelegationWithParties,
  fieldEncryption: FieldEncryptionService,
): Delegation {
  return {
    id: row.id,
    delegatorId: row.delegatorId,
    delegatorName: decodeIdentityField(
      row.delegator.fullNameCt,
      row.delegator.dekVersion,
      { column: 'full_name_ct', rowId: row.delegator.id },
      fieldEncryption,
    ),
    delegateId: row.delegateId,
    delegateName: decodeIdentityField(
      row.delegate.fullNameCt,
      row.delegate.dekVersion,
      { column: 'full_name_ct', rowId: row.delegate.id },
      fieldEncryption,
    ),
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo.toISOString(),
    reason: row.reason,
    createdBy: row.createdBy,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
