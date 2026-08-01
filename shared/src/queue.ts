import { z } from 'zod';
import { jobSummarySchema } from './job';

/**
 * `GET /queue` — PR-073/076/081, UR-049. Mirrors `api/openapi.yaml`'s
 * `QueueEntry` exactly (allOf `JobSummary` + these fields). A queue entry is
 * a `JobSummary` for a `SUBMITTED` job the caller (or an active delegator of
 * theirs, PR-076) is eligible to verify right now.
 *
 * `onBehalfOf` is the DELEGATOR's user id (not a display name) when this
 * entry is present in the response because of an active delegation, not the
 * caller's own eligibility — same field name/meaning as
 * `VerifyJobRequest.onBehalfOf` (job.ts) so a client can pass it straight
 * through to `POST /jobs/{id}/verify` unchanged.
 */
export const queueEntrySchema = jobSummarySchema.extend({
  submittedAt: z.string(),
  submittedByName: z.string().optional(),
  ageHours: z.number(),
  escalated: z.boolean(),
  onBehalfOf: z.string().uuid().nullable().optional(),
  /**
   * Slice 26-TWOSTAGE — WHICH stage of the route this record is waiting at,
   * and how many stages the route has. Required, not optional: a queue entry
   * is by construction a SUBMITTED job sitting at a configured stage (the
   * server resolves the stage to decide eligibility in the first place), so
   * there is no state in which these are unknown.
   *
   * The delivered route is two stages — TEAM_LEADER then ENGINEER — and a
   * queue that says nothing about the stage leaves a verifier unable to tell
   * where in the owner's process a record actually is. `stageLabel` is the
   * administrator-configured `approval_stage.label` verbatim (ADR-011 route-
   * as-data); the client renders it, it does not derive it from the ordinal.
   */
  stageOrdinal: z.number().int().positive(),
  stageCount: z.number().int().positive(),
  stageLabel: z.string(),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

// ------------------------------------------------------- GET /queue query params

export const listQueueQuerySchema = z.object({
  limit: z.union([z.string(), z.number()]).optional(),
  cursor: z.string().optional(),
});
export type ListQueueQuery = z.infer<typeof listQueueQuerySchema>;
