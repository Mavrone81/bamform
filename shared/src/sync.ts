import { z } from 'zod';
import { currentUserSchema } from './auth';
import { jobSchema } from './job';

/**
 * API_SPECIFICATION.md §11 "The Sync Protocol" — PR-API-22..27/PR-062/PR-082.
 * Mirrors `api/openapi.yaml`'s `SyncBootstrap`/`OutboxMutation`/`OutboxResult`
 * schemas exactly (the YAML is authoritative, BUILD_HANDOFF §1 read order).
 */

// -------------------------------------------------------------- Problem (RFC 9457)

/**
 * Minimal zod mirror of `openapi.yaml`'s `Problem` component — used only as
 * the shape of `OutboxResult.problem` here (no other shared DTO has needed
 * an error-body schema before this slice; every other module lets Nest's
 * exception filter produce the body and never re-validates it client-side).
 */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z
    .array(
      z.object({
        pointer: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .optional(),
});
export type Problem = z.infer<typeof problemSchema>;

// -------------------------------------------------------------- GET /sync/bootstrap

/**
 * PR-API-22/23/PR-059 response. `jobs[]` embeds the COMPLETE frozen template
 * revision per job (`jobSchema`'s `templateRevision` — active items/
 * measurements + standing content, slice 6) so the device renders offline
 * with no further call. `deletedJobIds` is optional (openapi: not in
 * `required`) — see `sync-bootstrap.service.ts` header for why it is
 * currently always `[]` (no mechanism in slices 1-8 moves a job OUT of a
 * user's scope after generation; PR-081/UR-029 reassignment is not yet
 * built). `syncToken` is an opaque cursor (`sync-cursor.ts`).
 */
export const syncBootstrapResponseSchema = z.object({
  serverTime: z.string(),
  user: currentUserSchema,
  jobs: z.array(jobSchema),
  deletedJobIds: z.array(z.string().uuid()).optional(),
  syncToken: z.string(),
});
export type SyncBootstrapResponse = z.infer<typeof syncBootstrapResponseSchema>;

// -------------------------------------------------------------- POST /sync/outbox

export const outboxMutationMethodSchema = z.enum(['PUT', 'POST', 'DELETE']);
export type OutboxMutationMethod = z.infer<typeof outboxMutationMethodSchema>;

/**
 * `id` doubles as the idempotency key (PR-API-25) — routed verbatim into the
 * SAME `IdempotencyService` slice 6 already established, per mutation.
 */
export const outboxMutationSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int(),
  clientRecordedAt: z.string().datetime({ offset: true }).optional(),
  method: outboxMutationMethodSchema,
  path: z.string().min(1),
  ifMatch: z.number().int().nullable().optional(),
  body: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type OutboxMutation = z.infer<typeof outboxMutationSchema>;

/** `maxItems: 200` mirrors `openapi.yaml`'s `/sync/outbox` requestBody. */
export const outboxRequestSchema = z.object({
  mutations: z.array(outboxMutationSchema).max(200),
});
export type OutboxRequest = z.infer<typeof outboxRequestSchema>;

/**
 * PR-API-24 — per-mutation, NOT all-or-nothing. `problem` is present only
 * when `applied` is `false`.
 */
export const outboxResultSchema = z.object({
  id: z.string().uuid(),
  status: z.number().int(),
  applied: z.boolean(),
  problem: problemSchema.optional(),
});
export type OutboxResult = z.infer<typeof outboxResultSchema>;

export const outboxResponseSchema = z.object({
  results: z.array(outboxResultSchema),
  syncToken: z.string().optional(),
});
export type OutboxResponse = z.infer<typeof outboxResponseSchema>;
