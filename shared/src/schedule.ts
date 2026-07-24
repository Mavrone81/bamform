import { z } from 'zod';
import { frequencySchema } from './frequency';

/**
 * DBD §6.14 `schedule_rule` — PR-029/PR-050..058. Matches `api/openapi.yaml`
 * `ScheduleRule`/`ScheduleAdjust` exactly (`GET`/`PUT /assets/{assetId}/schedule`).
 */
export const scheduleRuleSchema = z.object({
  id: z.string().uuid(),
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
  frequency: frequencySchema,
  nextDueOn: z.string().min(1),
  adjustedReason: z.string().trim().min(10),
});
export type ScheduleAdjustRequest = z.infer<typeof scheduleAdjustRequestSchema>;
