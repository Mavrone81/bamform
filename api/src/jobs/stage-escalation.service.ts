import { Injectable, Logger } from '@nestjs/common';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { VerifierEligibilityService } from '../queue/verifier-eligibility.service';
import { ApprovalRepository } from './approval.repository';

const HOURS_TO_MS = 3_600_000;

/**
 * PR-077/UR-050/UR-063 — "a record entered stage N's queue": schedules stage
 * N's escalation timer (if `approval_stage.escalation_hours` is configured —
 * `null` means none) and notifies every verifier currently eligible for
 * stage N.
 *
 * Extracted from `SubmissionService`'s submit-time private helper in slice
 * 15-SYSWIRE (SYS-7): submit enters stage 1, but a NON-FINAL verify enters
 * stage N+1 the exact same way — and until this extraction nothing scheduled
 * stage 2's escalation or told the stage-2 cohort anything, so the 72h
 * policy was dead for half the route. Both call sites now share this one
 * implementation, parameterised by stage.
 *
 * Best-effort by design (PR-150/151: `api` schedules, never sends): a Redis
 * blip must not roll back a submission/verification that already committed —
 * both callers invoke this AFTER their transaction commits, and every
 * failure is contained here.
 */
@Injectable()
export class StageEscalationService {
  private readonly logger = new Logger(StageEscalationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalRepo: ApprovalRepository,
    private readonly notificationQueue: NotificationQueueService,
    private readonly eligibility: VerifierEligibilityService,
  ) {}

  async scheduleForStage(jobId: string, stageOrdinal: number): Promise<void> {
    try {
      const row = await this.prisma.job.findUnique({
        where: { id: jobId },
        include: { asset: true },
      });
      if (!row) return;

      const escalationConfig = await this.approvalRepo.getStageEscalationConfig(
        row.approvalRouteId,
        stageOrdinal,
      );
      if (escalationConfig && escalationConfig.escalationHours != null) {
        await this.notificationQueue.scheduleEscalation({
          jobId,
          stageOrdinal,
          delayMs: escalationConfig.escalationHours * HOURS_TO_MS,
          recipientRoleCode: escalationConfig.escalateToRoleCode,
        });
      }

      const recipientIds = await this.eligibility.findEligibleVerifierIds({
        approvalRouteId: row.approvalRouteId,
        currentStageOrdinal: stageOrdinal,
        areaId: row.asset.areaId,
      });
      await this.notificationQueue.enqueueNotifications(
        recipientIds.map((recipientId) => ({
          recipientId,
          templateCode: 'RECORD_SUBMITTED' as const,
          entityType: 'job',
          entityId: jobId,
          payload: { jobNumber: row.jobNumber, assetCode: row.asset.code },
        })),
      );
    } catch (error) {
      const err = error as Error;
      // Best-effort operational signalling (class doc comment) — never fails
      // the state transition that already committed.
      this.logger.error(
        `stage-${stageOrdinal} escalation/notification scheduling failed for job ${jobId}: ${err.message}`,
      );
    }
  }
}
