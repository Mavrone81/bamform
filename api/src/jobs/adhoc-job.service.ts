import { Injectable, Logger } from '@nestjs/common';
import { AuditActionT, JobStatusT, Prisma } from '@prisma/client';
import type { CreateAdhocJobRequest, Job } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { AreaScopeService } from '../common/area-scope';
import type { ActorMeta } from '../common/actor-meta';
import {
  notFoundProblem,
  outOfScopeProblem,
  validationFailedProblem,
} from '../common/domain-problems';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { nextJobNumber } from '../scheduling/job-number';
import { AssignmentService } from './assignment.service';
import { JOB_FULL_INCLUDE } from './job-include';
import { toJob } from './mappers';

/** A `job_number` collision with a concurrent writer is retryable; anything else is not. */
const MAX_JOB_NUMBER_ATTEMPTS = 3;

/**
 * UR-028/PR-058 — `POST /jobs/adhoc`, raising a job against an asset OUTSIDE
 * the maintenance plan. Documented in API_SPECIFICATION.md §10.5 since slice
 * 1 ("Requires reason"), deferred in slice 5, and unbuilt until slice
 * 18-WORKFLOW, when the owner described the plant's real process: step 1 is
 * "view schedule based on maintenance plan OR AD-HOC REQUEST".
 *
 * The job is born exactly as a scheduler-generated one is — the asset's
 * asset-type's CURRENT template revision is FROZEN onto it (DP-3/PR-049), the
 * asset type's approval route is attached, the same `PM-{year}-{seq}`
 * numbering is drawn (`scheduling/job-number.ts`, now shared with
 * `JobGenerationService` rather than duplicated) — with two deliberate
 * differences:
 *
 *   `is_adhoc = true` + a mandatory `adhoc_reason` (>= 10 chars, enforced by
 *   the service AND by `job_adhoc_reason_length_chk`, mirroring INV-12/13),
 *   and an EMPTY `frequency_scope`.
 *
 * THE EMPTY SCOPE IS THE WHOLE POINT. An ad-hoc job is extra work, not the
 * planned service, so it must neither satisfy nor advance the schedule. Both
 * schedule-moving code paths are driven BY that scope and therefore do
 * nothing for an ad-hoc job — structurally, with no `if (isAdhoc)` anywhere
 * to forget:
 *
 *   - `CompletionCascadeService#apply` iterates `frequencyScope` to decide
 *     which `schedule_rule` rows to advance on the final verify. Empty ⇒ no
 *     rule is touched, no `last_completed_on`, no `next_due_on`, no audit.
 *   - `VoidScheduleRecomputeService#apply` re-derives `next_due_on` from
 *     "the most recent still-valid completion whose frozen scope covers this
 *     frequency" (`frequencyScope: { has: frequency }`). An empty scope
 *     covers nothing, so an archived ad-hoc job can never be credited as
 *     that completion.
 *
 * The period key (`job_asset_frequency_scope_due_on_scheduled_key`,
 * migration 20260728020010) is the second, independent half: it now excludes
 * ad-hoc rows, so raising ad-hoc work neither blocks the scheduler from
 * generating the planned PM for that period nor collides with a second
 * call-out on the same machine the same day.
 */
@Injectable()
export class AdhocJobService {
  private readonly logger = new Logger(AdhocJobService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly areaScope: AreaScopeService,
    private readonly assignment: AssignmentService,
    private readonly audit: AuditEventService,
    private readonly notificationQueue: NotificationQueueService,
  ) {}

  async create(dto: CreateAdhocJobRequest, actor: ActorMeta): Promise<Job> {
    const asset = await this.prisma.asset.findUnique({
      where: { id: dto.assetId },
      include: { assetType: true },
    });
    if (!asset) {
      throw notFoundProblem('Asset', dto.assetId);
    }

    // PR-API-10/ADR-005 — the SAME area rule every asset and job read
    // applies. A planner scoped to Area A does not raise work in Area B.
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(actor.actorId);
    if (allowedAreaIds !== null && (!asset.areaId || !allowedAreaIds.includes(asset.areaId))) {
      throw outOfScopeProblem('Asset');
    }

    if (!asset.active || asset.status !== 'active') {
      throw validationFailedProblem(
        'This asset is not active — no work can be raised against it (U-SCH-05 applies the same rule to the scheduler).',
      );
    }

    const revision = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: asset.assetType.formTemplateId, status: 'current' },
    });
    if (!revision) {
      throw validationFailedProblem(
        "This asset type's form template has no CURRENT revision — there is no checklist to freeze onto a job (DP-3/PR-049).",
      );
    }

    if (dto.assigneeId) {
      await this.assignment.assertAssignableUser(dto.assigneeId, asset.areaId);
    }

    const dueOn = dto.dueOn ? new Date(`${dto.dueOn}T00:00:00.000Z`) : todayUtc();
    const now = new Date();

    const dtoOut = await this.createWithRetry(dto, {
      assetId: asset.id,
      approvalRouteId: asset.assetType.approvalRouteId,
      templateRevisionId: revision.id,
      dueOn,
      now,
      actor,
    });

    if (dto.assigneeId) {
      // UR-061 — same best-effort, post-commit enqueue `AssignmentService`
      // does; a Redis blip never un-creates a job that already committed.
      try {
        await this.notificationQueue.enqueueNotification({
          recipientId: dto.assigneeId,
          templateCode: 'JOB_ASSIGNED',
          entityType: 'job',
          entityId: dtoOut.id,
          payload: { jobNumber: dtoOut.jobNumber, assetCode: asset.code },
        });
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `ad-hoc assignment notification enqueue failed for job ${dtoOut.id}: ${err.message}`,
        );
      }
    }

    return dtoOut;
  }

  /**
   * `nextJobNumber` reads-then-inserts inside one transaction, which is
   * TOCTOU-safe against itself but not against a CONCURRENT writer under
   * READ COMMITTED — a planner raising ad-hoc work can genuinely race a
   * scheduler tick and lose the `job_number` unique index. That is a
   * retryable collision on a value the caller never chose, so retry it
   * (bounded), exactly as `AssetsService#create` retries an auto-generated
   * asset code. A P2002 on anything else is re-thrown untouched.
   */
  private async createWithRetry(
    dto: CreateAdhocJobRequest,
    ctx: {
      assetId: string;
      approvalRouteId: string;
      templateRevisionId: string;
      dueOn: Date;
      now: Date;
      actor: ActorMeta;
    },
  ): Promise<Job> {
    for (let attempt = 1; attempt <= MAX_JOB_NUMBER_ATTEMPTS; attempt += 1) {
      try {
        return await this.insert(dto, ctx);
      } catch (error) {
        const collided =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          JSON.stringify(error.meta?.target ?? '').includes('job_number');
        if (!collided || attempt === MAX_JOB_NUMBER_ATTEMPTS) {
          throw error;
        }
        this.logger.warn(
          `job_number collision raising ad-hoc work on asset ${ctx.assetId} (attempt ${attempt}) — retrying`,
        );
      }
    }
    /* istanbul ignore next — the loop either returns or throws. */
    throw new Error('unreachable');
  }

  private async insert(
    dto: CreateAdhocJobRequest,
    ctx: {
      assetId: string;
      approvalRouteId: string;
      templateRevisionId: string;
      dueOn: Date;
      now: Date;
      actor: ActorMeta;
    },
  ): Promise<Job> {
    return this.prisma.$transaction(async (tx) => {
      const jobNumber = await nextJobNumber(tx, ctx.dueOn.getUTCFullYear());
      const created = await tx.job.create({
        data: {
          jobNumber,
          assetId: ctx.assetId,
          templateRevisionId: ctx.templateRevisionId,
          approvalRouteId: ctx.approvalRouteId,
          frequency: dto.frequency,
          // See the class doc comment: an empty scope is what makes this job
          // structurally incapable of moving the schedule.
          frequencyScope: [],
          dueOn: ctx.dueOn,
          generatedAt: ctx.now,
          isAdhoc: true,
          adhocReason: dto.reason,
          status: dto.assigneeId ? JobStatusT.assigned : JobStatusT.scheduled,
          assignedTo: dto.assigneeId ?? null,
          assignedAt: dto.assigneeId ? ctx.now : null,
        },
      });

      // INV-09 discipline (PR-098): the audit write shares this transaction.
      // The reason is business text the plant wrote about a MACHINE, not
      // personal data — auditing it is the point of UR-028 ("with a recorded
      // reason"), and it carries no decrypted PII (CR-5).
      await this.audit.record(tx, {
        actorId: ctx.actor.actorId,
        action: AuditActionT.create,
        entityType: 'job',
        entityId: created.id,
        after: {
          jobNumber: created.jobNumber,
          assetId: ctx.assetId,
          frequency: dto.frequency,
          frequencyScope: [],
          dueOn: created.dueOn,
          isAdhoc: true,
          adhocReason: dto.reason,
          assignedTo: dto.assigneeId ?? null,
        },
        sourceIp: ctx.actor.sourceIp,
        requestId: ctx.actor.requestId,
      });

      const full = await tx.job.findUniqueOrThrow({
        where: { id: created.id },
        include: JOB_FULL_INCLUDE,
      });
      return toJob(full);
    });
  }
}

/**
 * `due_on` is a DATE column — midnight UTC, no time-of-day, same as the
 * scheduler's (`job-generation.service.ts#dateOnly`).
 *
 * This is only the FALLBACK for a caller that omits `dueOn`. The web form
 * always sends one, and sends the DEVICE'S LOCAL date
 * (`web/src/lib/local-date.ts`, review finding X-7) — the tablet is in the
 * plant, so its local date is the plant's. The server keeps UTC because it
 * has no timezone configuration and every other date in the system is
 * UTC-derived; inventing a server-side plant timezone here would put a second,
 * unconfigured notion of "today" next to the scheduler's.
 */
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
