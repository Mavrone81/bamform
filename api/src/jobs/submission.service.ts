import { Injectable } from '@nestjs/common';
import { AuditActionT, JobStatusT } from '@prisma/client';
import type { Job } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { incompleteRecordProblem, invalidTransitionProblem } from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_FULL_INCLUDE } from './job-include';
import { JobsService } from './jobs.service';
import { toJob } from './mappers';
import { StageEscalationService } from './stage-escalation.service';
import { findOutstandingMandatoryItems } from './submission-gate';

const FIRST_STAGE = 1;

/**
 * PR-045/UR-039/ADR-013 — the submission completeness gate.
 * `POST /jobs/{id}/submit` is a SEPARATE atomic POST sub-resource
 * (non-negotiable #2/#11), never part of an outbox batch, rejected unless
 * every `mandatory` item on the frozen revision has an `item_result`.
 *
 * PR-077/UR-063 — a successful submission ALSO (outside the transaction,
 * after commit — `api` schedules, it never sends, PR-150/151) schedules
 * stage 1's escalation timer and notifies stage 1's eligible verifiers —
 * `StageEscalationService`, the stage-parameterised extraction of what used
 * to be a submit-only private helper (slice 15-SYSWIRE/SYS-7: a non-final
 * verify enters stage N+1 the same way submit enters stage 1, and now both
 * share the one implementation). Best-effort: a Redis blip never rolls back
 * the submission itself.
 */
@Injectable()
export class SubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    private readonly stageEscalation: StageEscalationService,
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
        // SYS-18 (slice 15-SYSWIRE) — re-assert the status INSIDE the
        // transaction, like verify/return/recall's guarded updateMany. The
        // pre-transaction check above closes the common case; this closes
        // the race where a void (or another transition) commits between that
        // read and this write — without it a just-voided job would be
        // silently resurrected to SUBMITTED (VOIDED has no immutability
        // trigger the way ARCHIVED does).
        const guarded = await tx.job.updateMany({
          where: { id: jobId, status: JobStatusT.in_progress },
          data: {
            status: JobStatusT.submitted,
            submittedAt: new Date(),
            submittedBy: actor.actorId,
            currentStageOrdinal: 1,
          },
        });
        if (guarded.count === 0) {
          throw invalidTransitionProblem(
            'This job changed state before the submission could be applied — reload and retry.',
          );
        }

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
        await this.stageEscalation.scheduleForStage(jobId, FIRST_STAGE);
        return dtoOut;
      });
  }
}
