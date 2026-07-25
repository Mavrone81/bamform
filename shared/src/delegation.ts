import { z } from 'zod';

/**
 * `delegation` (DBD §6.5, PR-038) — `GET/POST /delegations`,
 * `DELETE /delegations/{id}` (soft-revoke: sets `revokedAt`, never deletes
 * the row — API_SPECIFICATION.md §3's principal-endpoints table). Mirrors
 * `api/openapi.yaml`'s `Delegation`/`CreateDelegationRequest` exactly.
 *
 * `delegatorName`/`delegateName` follow the precedent
 * `api/src/auth/current-user.builder.ts#buildCurrentUser` already
 * established for `CurrentUser.activeDelegations[].delegatorName` — decrypting
 * `full_name_ct` for a delegation's counterparties is an already-accepted
 * read path, unlike the job-list `*Name` fields (see `api/src/jobs/mappers.ts`'s
 * comment), so this DTO documents them as populated, not omitted.
 */
export const delegationSchema = z.object({
  id: z.string().uuid(),
  delegatorId: z.string().uuid(),
  delegatorName: z.string().optional(),
  delegateId: z.string().uuid(),
  delegateName: z.string().optional(),
  validFrom: z.string(),
  validTo: z.string(),
  reason: z.string().nullable().optional(),
  createdBy: z.string().uuid(),
  revokedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Delegation = z.infer<typeof delegationSchema>;

/**
 * `POST /delegations` request body. Deliberately does NOT accept `createdBy`
 * from the client, unlike the PR-038 column list's literal wording — every
 * other mutation in this codebase derives the actor from the authenticated
 * session (`CurrentUser()`), never a client-supplied field (PR-090); this
 * follows the same rule. The server sets `createdBy` to the authenticated
 * caller's id.
 */
export const createDelegationRequestSchema = z
  .object({
    delegatorId: z.string().uuid(),
    delegateId: z.string().uuid(),
    validFrom: z.string().datetime({ offset: true }),
    validTo: z.string().datetime({ offset: true }),
    reason: z.string().trim().min(1).nullable().optional(),
  })
  .refine((v) => new Date(v.validTo).getTime() > new Date(v.validFrom).getTime(), {
    message: 'validTo must be after validFrom.',
    path: ['validTo'],
  })
  .refine((v) => v.delegatorId !== v.delegateId, {
    message: 'delegatorId and delegateId must differ — a user cannot delegate to themselves.',
    path: ['delegateId'],
  });
export type CreateDelegationRequest = z.infer<typeof createDelegationRequestSchema>;

// ---------------------------------------------------- GET /delegations query params

export const listDelegationsQuerySchema = z.object({
  limit: z.union([z.string(), z.number()]).optional(),
  cursor: z.string().optional(),
});
export type ListDelegationsQuery = z.infer<typeof listDelegationsQuerySchema>;
