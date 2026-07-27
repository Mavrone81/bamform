import { Injectable, Logger } from '@nestjs/common';
import { AuditActionT, JobStatusT, UserStatusT } from '@prisma/client';
import type { AssignJobRequest, Job } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { invalidTransitionProblem, validationFailedProblem } from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_RECORD_ROLES, JobAccessService } from './job-access';
import { JOB_FULL_INCLUDE } from './job-include';
import { JOB_STATUS_FROM_DB } from './job-enums';
import { JobsService } from './jobs.service';
import { assertLegalTransition } from './job-state-machine';
import { toJob } from './mappers';

/**
 * UR-029/PR-030 — `POST /jobs/{id}/assign` (slice 15-SYSWIRE, system-review
 * SYS-2). Before this slice NOTHING wrote `job.assigned_to`: scheduler-
 * generated jobs were born SCHEDULED/unassigned, invisible to MAINTAINERs
 * (`job-access.ts` restricts them to `assigned_to = me`) and unreachable by
 * result capture (`job-status-guard.ts` demands ASSIGNED/IN_PROGRESS) — the
 * generate→do→verify loop was severed at its first link.
 *
 * State semantics (PRD §5.1 + UR-029 "assignable ... and reassignable"):
 *   SCHEDULED   -> ASSIGNED   (first assignment — the lifecycle edge)
 *   ASSIGNED    -> ASSIGNED   (reassignment; assignee replaced)
 *   IN_PROGRESS -> IN_PROGRESS (reassignment mid-work — the deactivated-
 *                              assignee recovery path; recorded results keep
 *                              their original `recorded_by` attribution)
 * Anything else (SUBMITTED/ARCHIVED/VOIDED) is 409 invalid-transition.
 *
 * UR-061 — the assignment notification (built in slice 11a, unwired until
 * now) is enqueued post-commit to the new assignee, best-effort, exactly like
 * `SubmissionService`'s sibling notifications (`api` schedules, the worker
 * sends and is `NOTIFICATION_ENABLED`-gated — PR-150/151).
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly access: JobAccessService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    private readonly notificationQueue: NotificationQueueService,
  ) {}

  async assign(
    jobId: string,
    dto: AssignJobRequest,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({
        jobId,
        action: 'assign',
        assigneeId: dto.assigneeId,
      });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) {
        return replay.body as Job;
      }
    }

    // Actor-side authorisation: 404 unknown, 403 out-of-scope (area), plus
    // the role-driven visibility rule — the route-level @Roles() gate
    // (TL/ENG/ADMIN) already ran, and all three hold broad job visibility.
    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertLegalTransition(job.status, 'ASSIGN');

    await this.assertAssignableUser(dto.assigneeId, job.asset.areaId);

    const becomesAssigned = job.status === JobStatusT.scheduled;
    const previousAssignee = job.assignedTo;

    return this.prisma
      .$transaction(async (tx) => {
        // Conditional guard — re-asserts the pre-read status INSIDE the
        // transaction (same discipline as verify/return/recall, and the
        // SYS-18 fix applies it to submit/void too), so a transition that
        // committed between our read and this write cannot be overwritten.
        const guarded = await tx.job.updateMany({
          where: { id: jobId, status: job.status },
          data: {
            assignedTo: dto.assigneeId,
            ...(becomesAssigned ? { status: JobStatusT.assigned } : {}),
          },
        });
        if (guarded.count === 0) {
          throw invalidTransitionProblem(
            'This job changed state before the assignment could be applied — reload and retry.',
          );
        }

        await this.audit.record(tx, {
          actorId: actor.actorId,
          // First assignment is the PRD §5.1 SCHEDULED->ASSIGNED lifecycle
          // edge (state_change); a reassignment changes only the assignee.
          action: becomesAssigned ? AuditActionT.state_change : AuditActionT.update,
          entityType: 'job',
          entityId: jobId,
          before: {
            status: JOB_STATUS_FROM_DB[job.status],
            assignedTo: previousAssignee,
          },
          after: {
            status: JOB_STATUS_FROM_DB[becomesAssigned ? JobStatusT.assigned : job.status],
            assignedTo: dto.assigneeId,
          },
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
              endpoint: 'POST /jobs/{jobId}/assign',
              fingerprint,
            },
            { status: 200, body: dtoOut },
          );
        }

        return dtoOut;
      })
      .then(async (dtoOut) => {
        // UR-061 — best-effort, post-commit, never fails an assignment that
        // already committed (same stance as SubmissionService's doc comment).
        try {
          await this.notificationQueue.enqueueNotification({
            recipientId: dto.assigneeId,
            templateCode: 'JOB_ASSIGNED',
            entityType: 'job',
            entityId: jobId,
            payload: { jobNumber: job.jobNumber, assetCode: job.asset.code },
          });
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `assignment notification enqueue failed for job ${jobId}: ${err.message}`,
          );
        }
        return dtoOut;
      });
  }

  /**
   * The assignee must be able to actually WORK the job, or the assignment is
   * a dead end by construction: result capture is `@Roles(JOB_RECORD_ROLES)`,
   * a deactivated account is rejected at login (13a), and an area-scoped
   * user cannot even open an out-of-scope job (`JobAccessService`). All three
   * are 422 validation-failed — a client defect in the chosen assignee, not
   * an authorisation failure of the CALLER (which would be 403).
   */
  private async assertAssignableUser(assigneeId: string, jobAreaId: string | null): Promise<void> {
    const assignee = await this.prisma.appUser.findUnique({
      where: { id: assigneeId },
      include: { userRoles: { where: { active: true }, include: { role: true } } },
    });
    if (!assignee || assignee.status !== UserStatusT.active) {
      throw validationFailedProblem('assigneeId does not name an active user.');
    }
    const roleCodes = assignee.userRoles.map((userRole) => userRole.role.code);
    if (!roleCodes.some((code) => JOB_RECORD_ROLES.includes(code))) {
      throw validationFailedProblem(
        'The assignee holds no role that can record results (MAINTAINER/TEAM_LEADER/ENGINEER — API_SPECIFICATION.md §4.1).',
      );
    }
    const assigneeAreaIds = await this.access.getAllowedAreaIds(assigneeId);
    if (assigneeAreaIds !== null && (!jobAreaId || !assigneeAreaIds.includes(jobAreaId))) {
      throw validationFailedProblem(
        "The assignee's area scope does not include this job's area — they could never open it (PR-API-10).",
      );
    }
  }
}
