import { z } from 'zod';
import { frequencySchema } from './frequency';

/**
 * DBD §6.14 `schedule_rule` — PR-029/PR-050..058. Matches `api/openapi.yaml`
 * `ScheduleRule`/`ScheduleAdjust` exactly (`GET`/`PUT /assets/{assetId}/schedule`).
 */
export const scheduleRuleSchema = z.object({
  id: z.string().uuid(),
  /**
   * Slice 27-ASSETDOC: a rule now hangs off a DOCUMENT, not off a machine —
   * that is what lets TE7 carry a monthly pH-meter check AND its monthly PM.
   */
  assetDocumentId: z.string().uuid(),
  /** Derived from the document. Kept so every existing reader still works. */
  assetId: z.string().uuid(),
  frequency: frequencySchema,
  intervalMonths: z.number().int(),
  anchorDate: z.string(),
  lastCompletedOn: z.string().nullable(),
  nextDueOn: z.string(),
  adjustedReason: z.string().nullable(),
  active: z.boolean(),
});
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

/**
 * `PUT /assets/{assetId}/schedule` request — PR-058/UR-025: a manual
 * next-due-date adjustment always carries a mandatory reason (audited).
 * `minLength: 10` mirrors `rejectRevisionRequestSchema`/void/return's
 * reason fields (the same "a reason under 10 characters isn't a reason"
 * convention used throughout the DBD §7 CHECK constraints).
 */
export const scheduleAdjustRequestSchema = z.object({
  /**
   * Slice 27-ASSETDOC. Optional ONLY because a machine carrying exactly one
   * document has no ambiguity — omitting it there keeps every pre-slice-27
   * caller working. A machine carrying several documents MUST name one: with
   * two documents at the same frequency, `(assetId, frequency)` no longer
   * identifies a rule, and silently adjusting whichever came first is exactly
   * the cross-document defect this slice exists to prevent. The service
   * refuses the ambiguous case rather than guessing.
   */
  assetDocumentId: z.string().uuid().optional(),
  frequency: frequencySchema,
  nextDueOn: z.string().min(1),
  adjustedReason: z.string().trim().min(10),
});
export type ScheduleAdjustRequest = z.infer<typeof scheduleAdjustRequestSchema>;
