import type { NotificationTemplateCode } from './notification-payloads';

export interface NotificationContent {
  subject: string;
  text: string;
}

/**
 * UR-030/061/062/063/064/065's "configurable notification" is slice 13's
 * admin-editable-templates UI (out of scope here — see slice-11a-report.md's
 * deferral note); this is the minimal, fixed, English-only template set
 * that satisfies UR-061 (assignment) and UR-063/UR-050 (verifier-queue
 * entry / escalation) for THIS slice.
 */
export function buildNotificationContent(
  templateCode: NotificationTemplateCode,
  payload: Record<string, unknown>,
): NotificationContent {
  const jobNumber =
    typeof payload.jobNumber === 'string' ? payload.jobNumber : String(payload.jobNumber ?? '');
  const assetCode = typeof payload.assetCode === 'string' ? payload.assetCode : undefined;

  switch (templateCode) {
    case 'JOB_ASSIGNED':
      return {
        subject: `BamForm — job ${jobNumber} assigned to you`,
        text: `Job ${jobNumber}${assetCode ? ` (${assetCode})` : ''} has been assigned to you.`,
      };
    case 'RECORD_SUBMITTED':
      return {
        subject: `BamForm — record ${jobNumber} awaiting your verification`,
        text: `Job ${jobNumber}${assetCode ? ` (${assetCode})` : ''} has been submitted and is now in your verification queue.`,
      };
    case 'VERIFICATION_ESCALATED':
      return {
        subject: `BamForm — record ${jobNumber} overdue for verification`,
        text: `Job ${jobNumber}${assetCode ? ` (${assetCode})` : ''} has not been verified within the configured escalation window (UR-050).`,
      };
    default: {
      const exhaustive: never = templateCode;
      throw new Error(`Unhandled notification template code: ${String(exhaustive)}`);
    }
  }
}
