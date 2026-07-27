import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApprovalActionT, AuditActionT, JobStatusT, type Prisma } from '@prisma/client';
import type { Frequency, Job, ReturnJobRequest, VoidJobRequest } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { forbiddenProblem } from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { computeContentHash } from '../crypto/content-hash';
import { RECORD_SIGNING_SERVICE } from '../crypto/crypto.tokens';
import type { RecordSigningService } from '../crypto/record-signer';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { VoidScheduleRecomputeService } from '../scheduling/void-schedule-recompute.service';
import { ApprovalRepository } from './approval.repository';
import { buildCanonicalJobRecord } from './canonical-job-record';
import { JOB_STATUS_FROM_DB, JUDGEMENT_FROM_DB } from './job-enums';
import { JOB_FULL_INCLUDE, type JobFullRow } from './job-include';
import { JobsService } from './jobs.service';
import { assertLegalTransition } from './job-state-machine';
import { toJob } from './mappers';

/**
 * PR-046/074/075 — `return`/`recall`/`void`. Each is a content-bound-signed
 * `approval_step` (the same ADR-010 mechanism `VerificationService` uses for
 * `verify`, required because `approval_step.content_hash`/`.signature` are
 * NOT NULL columns for every action, DATABASE_DESIGN.md §6.20) but WITHOUT a
 * drawn signature (SAMUEL'S CONFIRMED DECISIONS scope the drawn signature to
 * `verify` only) and WITHOUT step-up (PR-API-07 names only verify/
 * revision-approve as signing actions requiring re-authentication).
 */
@Injectable()
export class ApprovalTransitionsService {
  private readonly logger = new Logger(ApprovalTransitionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly approvalRepo: ApprovalRepository,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    @Inject(RECORD_SIGNING_SERVICE) private readonly recordSigner: RecordSigningService,
    private readonly notificationQueue: NotificationQueueService,
    private readonly voidScheduleRecompute: VoidScheduleRecomputeService,
  ) {}

  async return_(
    jobId: string,
    dto: ReturnJobRequest,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({ jobId, action: 'return', reason: dto.reason });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) return replay.body as Job;
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertLegalTransition(job.status, 'RETURN');
    const stageOrdinal = job.currentStageOrdinal ?? 1;

    return this.runTransition(job, {
      jobId,
      idempotencyKey,
      fingerprint,
      actor,
      endpoint: 'POST /jobs/{jobId}/return',
      action: ApprovalActionT.returned,
      stageOrdinal,
      reason: dto.reason,
      dbUpdateWhereExtra: { status: JobStatusT.submitted },
      dbUpdateData: { status: JobStatusT.in_progress, currentStageOrdinal: null },
      canonicalStatus: 'IN_PROGRESS',
      auditBefore: { status: 'SUBMITTED' },
      auditAfter: { status: 'IN_PROGRESS', reason: dto.reason },
      actorRoleCode: roles.join('+') || 'UNKNOWN',
    });
  }

  async recall(
    jobId: string,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({ jobId, action: 'recall' });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) return replay.body as Job;
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertLegalTransition(job.status, 'RECALL');
    // PR-075/UR-051: submitter only.
    if (job.submittedBy !== actor.actorId) {
      throw forbiddenProblem('Only the submitter may recall this record (PR-075, UR-051).');
    }
    const stageOrdinal = job.currentStageOrdinal ?? 1;

    return this.runTransition(job, {
      jobId,
      idempotencyKey,
      fingerprint,
      actor,
      endpoint: 'POST /jobs/{jobId}/recall',
      action: ApprovalActionT.recalled,
      stageOrdinal,
      reason: null,
      dbUpdateWhereExtra: { status: JobStatusT.submitted },
      dbUpdateData: { status: JobStatusT.in_progress, currentStageOrdinal: null },
      canonicalStatus: 'IN_PROGRESS',
      auditBefore: { status: 'SUBMITTED' },
      auditAfter: { status: 'IN_PROGRESS' },
      actorRoleCode: roles.join('+') || 'UNKNOWN',
    });
  }

  async void_(
    jobId: string,
    dto: VoidJobRequest,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({ jobId, action: 'void', reason: dto.reason });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) return replay.body as Job;
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertLegalTransition(job.status, 'VOID');
    // PR-046: void leaves the record visible/queryable — a soft terminal
    // status, never a delete (no-DELETE non-negotiable).
    const stageOrdinal = job.currentStageOrdinal ?? 0;
    const now = new Date();

    // Slice 17-VOID — the owner's 2026-07-27 decision: void is reachable
    // AFTER archive too, as an ANNOTATION on the untouched double-signed
    // record (the amended INV-09 trigger enforces byte-identity of every
    // non-annotation column at the database). Post-archive void is
    // ADMIN-only; the pre-archive role set (route-level TL/ENG/ADMIN) is
    // unchanged. `reason` is mandatory for both (INV-12, >= 10 chars).
    const isPostArchive = job.status === JobStatusT.archived;
    if (isPostArchive && !roles.includes('ADMIN')) {
      throw forbiddenProblem(
        'Voiding an archived record is ADMIN-only (owner decision 2026-07-27, slice 17).',
      );
    }

    return this.runTransition(job, {
      jobId,
      idempotencyKey,
      fingerprint,
      actor,
      endpoint: 'POST /jobs/{jobId}/void',
      action: ApprovalActionT.voidedAction,
      stageOrdinal,
      reason: dto.reason,
      // SYS-18 (slice 15-SYSWIRE) — void previously passed `{}` here, making
      // it the one transition whose guarded WHERE re-asserted nothing: a
      // concurrent archive/void committing inside the read->write window
      // would be overwritten. Re-assert VOID's legal-from set for the path
      // taken: post-archive pins `archived` exactly (an ADMIN-authorised
      // post-archive void must not silently absorb a pre-archive race, whose
      // authorisation and schedule semantics differ); pre-archive keeps the
      // whole pre-terminal set (any of them is still a valid void source, so
      // pinning the exact pre-read status would reject a harmless
      // SCHEDULED->ASSIGNED race).
      dbUpdateWhereExtra: isPostArchive
        ? { status: JobStatusT.archived }
        : {
            status: {
              in: [
                JobStatusT.scheduled,
                JobStatusT.assigned,
                JobStatusT.in_progress,
                JobStatusT.submitted,
              ],
            },
          },
      dbUpdateData: {
        status: JobStatusT.voided,
        voidReason: dto.reason,
        voidedBy: actor.actorId,
        voidedAt: now,
      },
      canonicalStatus: 'VOIDED',
      auditBefore: { status: JOB_STATUS_FROM_DB[job.status] },
      auditAfter: isPostArchive
        ? { status: 'VOIDED', reason: dto.reason, postArchive: true }
        : { status: 'VOIDED', reason: dto.reason },
      actorRoleCode: roles.join('+') || 'UNKNOWN',
      // Owner decision consequence 1: the schedule behaves as if the voided
      // PM never happened — recomputed IN THE SAME TRANSACTION as the void
      // annotation (a void without its recompute would leave the schedule
      // crediting a completion the plant just disowned). Pre-archive voids
      // never advanced the schedule, so there is nothing to undo there —
      // regeneration for those is handled purely by the partial period key
      // (20260728000010).
      afterGuardedUpdateInTx: isPostArchive
        ? (tx) =>
            this.voidScheduleRecompute.apply(tx, {
              jobId,
              assetId: job.assetId,
              frequencyScope: job.frequencyScope as Frequency[],
              voidedJobDueOn: job.dueOn,
              actorId: actor.actorId,
            })
        : undefined,
    });
  }

  /**
   * Shared machinery for return/recall/void: conditional guarded update,
   * content-bound sign, append-only `approval_step`, in-transaction audit,
   * idempotency record. `verify`'s extra concerns (drawn signature, step-up,
   * multi-stage archive-in-txn) are NOT shared — `VerificationService` stays
   * separate rather than forcing this helper to grow those branches too.
   */
  private async runTransition(
    job: JobFullRow,
    params: {
      jobId: string;
      idempotencyKey: string | undefined;
      fingerprint: Buffer | undefined;
      actor: ActorMeta;
      endpoint: string;
      action: ApprovalActionT;
      stageOrdinal: number;
      reason: string | null;
      dbUpdateWhereExtra: Record<string, unknown>;
      dbUpdateData: Record<string, unknown>;
      canonicalStatus: string;
      auditBefore: Record<string, unknown>;
      auditAfter: Record<string, unknown>;
      actorRoleCode: string;
      /**
       * Slice 17 — runs INSIDE the transaction, immediately after the guarded
       * status update succeeds (mirrors where `VerificationService` calls the
       * forward completion cascade). Used by the post-archive void to
       * recompute the asset's schedule atomically with the annotation.
       */
      afterGuardedUpdateInTx?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ): Promise<Job> {
    const approvalStepId = randomUUID();
    const now = new Date();

    return this.prisma
      .$transaction(async (tx) => {
        const guarded = await tx.job.updateMany({
          where: { id: params.jobId, ...params.dbUpdateWhereExtra },
          data: params.dbUpdateData,
        });
        if (guarded.count === 0) {
          throw forbiddenProblem(
            'This record changed state before this action could be applied — reload and retry.',
          );
        }

        if (params.afterGuardedUpdateInTx) {
          await params.afterGuardedUpdateInTx(tx);
        }

        const priorSteps = await this.approvalRepo.listApprovalSteps(params.jobId, tx);

        const canonicalRecord = buildCanonicalJobRecord({
          job: {
            id: job.id,
            jobNumber: job.jobNumber,
            assetId: job.assetId,
            templateRevisionId: job.templateRevisionId,
            frequency: job.frequency,
            status: params.canonicalStatus,
          },
          templateRevision: {
            id: job.templateRevision.id,
            formTemplateId: job.templateRevision.formTemplateId,
            revisionCode: job.templateRevision.revisionCode,
            sequenceOrdinal: job.templateRevision.sequenceOrdinal,
          },
          submitter: { userId: job.submittedBy, submittedAt: job.submittedAt },
          itemResults: job.itemResults.map((r) => ({
            id: r.id,
            templateItemId: r.templateItemId,
            status: r.status,
            remark: r.remark,
          })),
          measurementResults: job.measurementResults.map((r) => ({
            id: r.id,
            templateMeasurementId: r.templateMeasurementId,
            readingNumeric: r.readingNumeric ? r.readingNumeric.toString() : null,
            readingText: r.readingText,
            judgement: JUDGEMENT_FROM_DB[r.judgement],
          })),
          partsUsed: job.partsUsed.map((p) => ({
            id: p.id,
            partNo: p.partNo,
            description: p.description,
            quantity: p.quantity.toString(),
          })),
          attachments: job.attachments.map((a) => ({
            id: a.id,
            sha256Hex: Buffer.from(a.sha256).toString('hex'),
          })),
          approvalSteps: [
            ...priorSteps.map((s) => ({
              id: s.id,
              stageOrdinal: s.stageOrdinal,
              action: s.action,
              actorId: s.actorId,
              onBehalfOfId: s.onBehalfOfId,
              reason: s.reason,
              actedAt: s.actedAt,
            })),
            {
              id: approvalStepId,
              stageOrdinal: params.stageOrdinal,
              action: params.action,
              actorId: params.actor.actorId,
              onBehalfOfId: null,
              reason: params.reason,
              actedAt: now,
            },
          ],
        });
        const contentHash = computeContentHash(canonicalRecord);
        const signature = this.recordSigner.sign(contentHash);

        await this.approvalRepo.createApprovalStep(tx, {
          id: approvalStepId,
          jobId: params.jobId,
          stageOrdinal: params.stageOrdinal,
          action: params.action,
          actorId: params.actor.actorId,
          onBehalfOfId: null,
          actorRoleCode: params.actorRoleCode, // return/recall/void are not stage-role-gated per API_SPECIFICATION.md §4.1
          reason: params.reason,
          actedAt: now,
          sourceIp: params.actor.sourceIp,
          contentHash,
          signature,
          signingKeyId: this.recordSigner.kid,
          stepUpVerifiedAt: null,
          drawnSignatureCt: null,
          drawnSignatureDekVersion: null,
        });

        await this.audit.record(tx, {
          actorId: params.actor.actorId,
          action: AuditActionT.state_change,
          entityType: 'job',
          entityId: params.jobId,
          before: params.auditBefore,
          after: params.auditAfter,
          sourceIp: params.actor.sourceIp,
          requestId: params.actor.requestId,
        });

        const full = await tx.job.findUniqueOrThrow({
          where: { id: params.jobId },
          include: JOB_FULL_INCLUDE,
        });
        const dtoOut = toJob(full);

        if (params.idempotencyKey && params.fingerprint) {
          await this.idempotency.recordWithin(
            tx,
            {
              key: params.idempotencyKey,
              userId: params.actor.actorId,
              endpoint: params.endpoint,
              fingerprint: params.fingerprint,
            },
            { status: 200, body: dtoOut },
          );
        }

        return dtoOut;
      })
      .then(async (dtoOut) => {
        // PR-077 — return/recall/void all take the job OUT of "awaiting
        // verification at this stage" the same way a `verify` does; a stale
        // escalation timer left running for a job that is back IN_PROGRESS
        // (or voided) would fire a false reminder. Best-effort, outside the
        // transaction — see `VerificationService#verify`'s identical pattern.
        try {
          await this.notificationQueue.cancelEscalation(params.jobId, params.stageOrdinal);
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `escalation cancel failed for job ${params.jobId} stage ${params.stageOrdinal}: ${err.message}`,
          );
        }
        return dtoOut;
      });
  }
}
