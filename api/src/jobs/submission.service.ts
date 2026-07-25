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
import { findOutstandingMandatoryItems } from './submission-gate';

/**
 * PR-045/UR-039/ADR-013 — the submission completeness gate.
 * `POST /jobs/{id}/submit` is a SEPARATE atomic POST sub-resource
 * (non-negotiable #2/#11), never part of an outbox batch, rejected unless
 * every `mandatory` item on the frozen revision has an `item_result`.
 */
@Injectable()
export class SubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
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

    return this.prisma.$transaction(async (tx) => {
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
    });
  }
}
