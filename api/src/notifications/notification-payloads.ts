/**
 * The two BullMQ job payload shapes carried on the `bamform-notifications`
 * queue (`notification.tokens.ts`). Kept in one file, dependency-free, so
 * both the producer side (`NotificationQueueService`, imported by `api`'s
 * `jobs`/`delegations` modules) and the consumer side
 * (`NotificationDispatchService`, `worker`-only) agree on the wire shape
 * without importing each other.
 */

/** A single immediate notification (UR-061 assignment, UR-063 verifier-queue). */
export interface NotificationJobPayload {
  recipientId: string;
  templateCode: NotificationTemplateCode;
  entityType: string;
  entityId: string;
  /** Template-specific data (job number, asset code, ...) — never personal data (PR-106): the recipient's own identity is looked up server-side from `recipientId`, never carried in this payload. */
  payload: Record<string, unknown>;
}

/** PR-077 — a delayed job scheduled at submission (or stage entry), cancelled on verification, that fires an ESCALATION notification if it matures. */
export interface EscalationJobPayload {
  jobId: string;
  stageOrdinal: number;
  /** `approval_stage.escalate_to_role_id`'s code, resolved at schedule time — `null` means "fall back to whoever is currently eligible to verify this stage" (`VerifierEligibilityService`). */
  recipientRoleCode: string | null;
}

export const NOTIFICATION_TEMPLATE_CODES = [
  'JOB_ASSIGNED',
  'RECORD_SUBMITTED',
  'VERIFICATION_ESCALATED',
] as const;
export type NotificationTemplateCode = (typeof NOTIFICATION_TEMPLATE_CODES)[number];
