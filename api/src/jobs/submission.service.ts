import { Injectable, Logger } from '@nestjs/common';
import { AuditActionT, JobStatusT } from '@prisma/client';
import type { Job } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { incompleteRecordProblem, invalidTransitionProblem } from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { VerifierEligibilityService } from '../queue/verifier-eligibility.service';
import { ApprovalRepository } from './approval.repository';
import { JOB_FULL_INCLUDE } from './job-include';
import { JobsService } from './jobs.service';
import { toJob } from './mappers';
import { findOutstandingMandatoryItems } from './submission-gate';

const HOURS_TO_MS = 3_600_000;
const FIRST_STAGE = 1;

/**
 * PR-045/UR-039/ADR-013 — the submission completeness gate.
 * `POST /jobs/{id}/submit` is a SEPARATE atomic POST sub-resource
 * (non-negotiable #2/#11), never part of an outbox batch, rejected unless
 * every `mandatory` item on the frozen revision has an `item_result`.
 *
 * PR-077/UR-063 — a successful submission ALSO (outside the transaction,
 * after commit — `api` schedules, it never sends, PR-150/151): schedules
 * stage 1's escalation timer (if `approval_stage.escalation_hours` is
 * configured for it — `null` means none, see `ApprovalRepository
 * #getStageEscalationConfig`'s doc comment) and enqueues a "record entered
 * your queue" notification to every verifier currently eligible for stage 1.
 * Neither failing (e.g. Redis briefly unreachable) rolls back the
 * submission — a notification/escalation is best-effort operational
 * signalling, not part of the durable job-state transition itself.
 */
@Injectable()
export class SubmissionService {
  private readonly logger = new Logger(SubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    private readonly approvalRepo: ApprovalRepository,
    private readonly notificationQueue: NotificationQueueService,
    private readonly eligibility: VerifierEligibilityService,
  ) {}

  async submit(
    jobId: string,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({ jobId });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) {
        return replay.body as Job;
      }
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    if (job.status !== JobStatusT.in_progress) {
      throw invalidTransitionProblem(
        `Job is ${job.status} — only an IN_PROGRESS job can be submitted (PRD §5.1).`,
      );
    }

    const recordedTemplateItemIds = new Set(job.itemResults.map((r) => r.templateItemId));
    const outstanding = findOutstandingMandatoryItems(
      job.templateRevision.items,
      recordedTemplateItemIds,
    );
    if (outstanding.length > 0) {
      throw incompleteRecordProblem(outstanding);
    }

    return this.prisma
      .$transaction(async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: {
            status: JobStatusT.submitted,
            submittedAt: new Date(),
            submittedBy: actor.actorId,
            currentStageOrdinal: 1,
          },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.state_change,
          entityType: 'job',
          entityId: jobId,
          before: { status: 'IN_PROGRESS' },
          after: { status: 'SUBMITTED' },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        const full = await tx.job.findUniqueOrThrow({
          where: { id: jobId },
          include: JOB_FULL_INCLUDE,
        });
        const dtoOut = toJob(full);

        if (idempotencyKey && fingerprint) {
          await this.idempotency.recordWithin(
            tx,
            {
              key: idempotencyKey,
              userId: actor.actorId,
              endpoint: 'POST /jobs/{jobId}/submit',
              fingerprint,
            },
            { status: 200, body: dtoOut },
          );
        }

        return dtoOut;
      })
      .then(async (dtoOut) => {
        await this.scheduleEscalationAndNotify(jobId);
        return dtoOut;
      });
  }

  private async scheduleEscalationAndNotify(jobId: string): Promise<void> {
    try {
      const row = await this.prisma.job.findUnique({
        where: { id: jobId },
        include: JOB_FULL_INCLUDE,
      });
      if (!row) return;

      const escalationConfig = await this.approvalRepo.getStageEscalationConfig(
        row.approvalRouteId,
        FIRST_STAGE,
      );
      if (escalationConfig && escalationConfig.escalationHours != null) {
        await this.notificationQueue.scheduleEscalation({
          jobId,
          stageOrdinal: FIRST_STAGE,
          delayMs: escalationConfig.escalationHours * HOURS_TO_MS,
          recipientRoleCode: escalationConfig.escalateToRoleCode,
        });
      }

      const recipientIds = await this.eligibility.findEligibleVerifierIds({
        approvalRouteId: row.approvalRouteId,
        currentStageOrdinal: FIRST_STAGE,
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
      // Best-effort operational signalling (see class doc comment) — never fails the submission itself.
      this.logger.error(
        `post-submission notification/escalation scheduling failed for job ${jobId}: ${err.message}`,
      );
    }
  }
}
