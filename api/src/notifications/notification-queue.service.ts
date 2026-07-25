import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { NOTIFICATION_QUEUE } from './notification.tokens';
import type { EscalationJobPayload, NotificationJobPayload } from './notification-payloads';

/** BullMQ retains failed jobs for operational visibility (ENVIRONMENT_REQUIREMENTS.md's "queued notifications not draining" alert) but not forever — bounded per PR-ENV-style hygiene, not a business rule. */
const REMOVE_ON_FAIL_COUNT = 500;

/**
 * Producer side of the `bamform-notifications` queue (PR-009) — the ONLY
 * class `api` (never `worker`) imports from this module. `api` schedules;
 * `worker` (a completely separate module graph, `notifications.module.ts`,
 * `WorkerModule`-only) consumes and sends (PR-150/151: the worker sends,
 * the api does not).
 */
@Injectable()
export class NotificationQueueService {
  constructor(@Inject(NOTIFICATION_QUEUE) private readonly queue: Queue) {}

  async enqueueNotification(payload: NotificationJobPayload): Promise<void> {
    await this.queue.add('notification', payload, {
      removeOnComplete: true,
      removeOnFail: REMOVE_ON_FAIL_COUNT,
    });
  }

  async enqueueNotifications(payloads: readonly NotificationJobPayload[]): Promise<void> {
    if (payloads.length === 0) return;
    await this.queue.addBulk(
      payloads.map((payload) => ({
        name: 'notification' as const,
        data: payload,
        opts: { removeOnComplete: true, removeOnFail: REMOVE_ON_FAIL_COUNT },
      })),
    );
  }

  /** Deterministic per job+stage — `scheduleEscalation`/`cancelEscalation` agree on this without either side needing to remember an id BullMQ generated. */
  escalationJobId(jobId: string, stageOrdinal: number): string {
    return `escalation:${jobId}:${stageOrdinal}`;
  }

  /**
   * PR-077 — schedules the delayed job at submission (or stage entry) time.
   * A no-op call site guard (not enforced here): the caller must not invoke
   * this when the stage's `escalation_hours` is `null` — see
   * `notifications/escalation.service.ts`'s doc comment for why `NULL`
   * means "no escalation for this stage", not "use a default".
   */
  async scheduleEscalation(params: {
    jobId: string;
    stageOrdinal: number;
    delayMs: number;
    recipientRoleCode: string | null;
  }): Promise<void> {
    const payload: EscalationJobPayload = {
      jobId: params.jobId,
      stageOrdinal: params.stageOrdinal,
      recipientRoleCode: params.recipientRoleCode,
    };
    await this.queue.add('escalation', payload, {
      jobId: this.escalationJobId(params.jobId, params.stageOrdinal),
      delay: params.delayMs,
      removeOnComplete: true,
      removeOnFail: REMOVE_ON_FAIL_COUNT,
    });
  }

  /** PR-077 — "cancelled on verification". Safe no-op if nothing was scheduled (e.g. the stage had no `escalation_hours` configured). */
  async cancelEscalation(jobId: string, stageOrdinal: number): Promise<void> {
    const id = this.escalationJobId(jobId, stageOrdinal);
    const job = await this.queue.getJob(id);
    if (job) {
      await job.remove();
    }
  }

  /** Exposed for tests/diagnostics — not used by production call sites. */
  async getEscalationJob(jobId: string, stageOrdinal: number) {
    return this.queue.getJob(this.escalationJobId(jobId, stageOrdinal));
  }
}
