import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApprovalActionT, AuditActionT, JobStatusT } from '@prisma/client';
import type { Frequency, Job, VerifyJobRequest } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import {
  forbiddenProblem,
  invalidTransitionProblem,
  selfApprovalProblem,
} from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { FIELD_ENCRYPTION_SERVICE, RECORD_SIGNING_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { computeContentHash } from '../crypto/content-hash';
import type { RecordSigningService } from '../crypto/record-signer';
import { NotificationQueueService } from '../notifications/notification-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionCascadeService } from '../scheduling/completion-cascade.service';
import { ApprovalRepository } from './approval.repository';
import { buildCanonicalJobRecord } from './canonical-job-record';
import { decodeAndValidateDrawnSignature } from './drawn-signature';
import { JOB_STATUS_FROM_DB, JUDGEMENT_FROM_DB } from './job-enums';
import { JOB_FULL_INCLUDE } from './job-include';
import { JobsService } from './jobs.service';
import { assertLegalTransition } from './job-state-machine';
import { toJob } from './mappers';
import { StageEscalationService } from './stage-escalation.service';

/**
 * PR-041..046/070..077/093/094 — the two-stage verification transition
 * (`POST /jobs/{id}/verify`). SAMUEL'S CONFIRMED DECISIONS (slice-7-brief.md):
 * two verification stages, each verifier signing with an on-system DRAWN
 * signature PLUS the content-bound Ed25519 signature (ADR-010). On the LAST
 * stage, `SUBMITTED -> ARCHIVED` happens in the SAME transaction (INV-13/
 * PR-042) — the job never rests `VERIFIED`.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly approvalRepo: ApprovalRepository,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    @Inject(RECORD_SIGNING_SERVICE) private readonly recordSigner: RecordSigningService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
    private readonly notificationQueue: NotificationQueueService,
    private readonly completionCascade: CompletionCascadeService,
    private readonly stageEscalation: StageEscalationService,
  ) {}

  async verify(
    jobId: string,
    dto: VerifyJobRequest,
    idempotencyKey: string | undefined,
    stepUpVerifiedAt: Date,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      fingerprint = this.idempotency.fingerprint({
        jobId,
        drawnSignature: dto.drawnSignature,
        onBehalfOf: dto.onBehalfOf ?? null,
      });
      const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
      if (replay) {
        return replay.body as Job;
      }
    }

    const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
    assertLegalTransition(job.status, 'VERIFY_ADVANCE'); // VERIFY_ADVANCE/VERIFY_FINAL share the same legal-from set (SUBMITTED)

    // PR-044/INV-05, service-layer half of the "service AND DB" requirement
    // (the DB half is `enforce_verifier_not_submitter`, slice 1 —
    // 20260723180000_invariants — the backstop for a genuine race).
    if (job.submittedBy === actor.actorId) {
      throw selfApprovalProblem(
        'You submitted this record and cannot verify your own work (INV-05, PR-044).',
      );
    }

    const stageOrdinal = job.currentStageOrdinal ?? 1;
    const stage = await this.approvalRepo.getStageWithRoles(job.approvalRouteId, stageOrdinal);
    if (!stage) {
      throw invalidTransitionProblem(
        `No approval stage ${stageOrdinal} is configured for this job's approval route.`,
      );
    }

    const { matchedRoleCode, onBehalfOfId } = await this.resolveEligibility(
      actor,
      roles,
      dto,
      stage.roleCodes,
    );

    // Drawn signature: decode + magic-byte-validate BEFORE opening the
    // transaction (S-30-style content validation should never depend on a
    // DB round trip having already started).
    const drawnPng = decodeAndValidateDrawnSignature(dto.drawnSignature);

    const stageCount = await this.approvalRepo.getStageCount(job.approvalRouteId);
    const isFinalStage = stageOrdinal >= stageCount;

    const approvalStepId = randomUUID();
    const now = new Date();

    return this.prisma
      .$transaction(async (tx) => {
        // Conditional guard — INV-13/PR-042's "same transaction" promise also
        // means a concurrent verifier for the SAME stage must not both
        // succeed; this WHERE re-asserts the preconditions atomically.
        const guarded = await tx.job.updateMany({
          where: { id: jobId, status: JobStatusT.submitted, currentStageOrdinal: stageOrdinal },
          data: isFinalStage
            ? {
                status: JobStatusT.archived,
                verifiedAt: now,
                archivedAt: now,
                currentStageOrdinal: null,
              }
            : { currentStageOrdinal: stageOrdinal + 1 },
        });
        if (guarded.count === 0) {
          throw invalidTransitionProblem(
            'This record was already advanced by another verifier — reload and retry.',
          );
        }

        // SYS-1 (slice 15-SYSWIRE) — PR-055/056: the final verify is what
        // completes the PM cycle, so the SAME transaction that archives the
        // job advances `schedule_rule.last_completed_on`/`next_due_on` for
        // every frequency the job's frozen `frequency_scope` subsumes
        // (1M→{1M}, 3M→{1M,3M}, 6M→{1M,3M,6M}, Y→all — PR-053's scope,
        // computed at generation). `CompletionCascadeService` was built in
        // slice 5 exactly for this call site (see its doc comment: "must be
        // called with the SAME transaction client"); until this slice nothing
        // called it, so recurring generation died after one cycle per asset.
        if (isFinalStage) {
          await this.completionCascade.apply(tx, {
            jobId,
            assetDocumentId: job.assetDocumentId,
            assetId: job.assetId,
            frequencyScope: job.frequencyScope as Frequency[],
            verifiedOn: now,
            actorId: actor.actorId,
          });
        }

        const priorSteps = await this.approvalRepo.listApprovalSteps(jobId, tx);

        // SYS-8 (slice 15-SYSWIRE) — two-verifier means two PEOPLE. A user
        // holding TEAM_LEADER + ENGINEER passes both stages' role gates, but
        // the ISO intent (and all 12 source forms) is independent review:
        // the same human must not supply both signatures. Scope is the
        // CURRENT submission cycle — a return/recall supersedes earlier
        // signatures (the canonical content they signed no longer exists),
        // so only `verified` steps after the last `returned`/`recalled` step
        // count. Checked inside the transaction (after the guarded update,
        // reading with `tx`) and backstopped by the
        // `approval_step_distinct_stage_verifiers_trg` DB trigger, mirroring
        // INV-05's service+trigger pattern.
        const lastCycleBreak = priorSteps.reduce<Date | null>(
          (latest, step) =>
            (step.action === ApprovalActionT.returned ||
              step.action === ApprovalActionT.recalled) &&
            (!latest || step.actedAt > latest)
              ? step.actedAt
              : latest,
          null,
        );
        const alreadyVerifiedThisCycle = priorSteps.some(
          (step) =>
            step.action === ApprovalActionT.verified &&
            step.actorId === actor.actorId &&
            (!lastCycleBreak || step.actedAt > lastCycleBreak),
        );
        if (alreadyVerifiedThisCycle) {
          throw selfApprovalProblem(
            'You already verified an earlier stage of this record — the two verification signatures must come from two different people (SYS-8, UR-045 intent).',
          );
        }

        const canonicalRecord = buildCanonicalJobRecord({
          job: {
            id: job.id,
            jobNumber: job.jobNumber,
            assetId: job.assetId,
            templateRevisionId: job.templateRevisionId,
            frequency: job.frequency,
            status: JOB_STATUS_FROM_DB[isFinalStage ? JobStatusT.archived : JobStatusT.submitted],
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
              stageOrdinal,
              action: ApprovalActionT.verified,
              actorId: actor.actorId,
              onBehalfOfId,
              reason: dto.comment ?? null,
              actedAt: now,
            },
          ],
        });
        const contentHash = computeContentHash(canonicalRecord);
        const signature = this.recordSigner.sign(contentHash);

        const encryptedDrawn = this.fieldEncryption.encrypt(drawnPng.toString('base64'), {
          table: 'approval_step',
          column: 'drawn_signature_ct',
          rowId: approvalStepId,
        });

        await this.approvalRepo.createApprovalStep(tx, {
          id: approvalStepId,
          jobId,
          stageOrdinal,
          // Slice 26-TWOSTAGE M1 — snapshot the stage's configured caption
          // into the same transaction that writes the signature, so a later
          // administrative relabel (routes are data, ADR-011) can never
          // rewrite what this archived record says was attested.
          stageLabel: stage.label,
          action: ApprovalActionT.verified,
          actorId: actor.actorId,
          onBehalfOfId,
          actorRoleCode: matchedRoleCode,
          reason: dto.comment ?? null,
          actedAt: now,
          sourceIp: actor.sourceIp,
          contentHash,
          signature,
          signingKeyId: this.recordSigner.kid,
          stepUpVerifiedAt,
          drawnSignatureCt: encryptedDrawn.ciphertext,
          drawnSignatureDekVersion: encryptedDrawn.dekVersion,
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          onBehalfOfId: onBehalfOfId ?? undefined,
          action: AuditActionT.approve,
          entityType: 'job',
          entityId: jobId,
          before: { status: 'SUBMITTED', stageOrdinal },
          after: isFinalStage
            ? { status: 'ARCHIVED', stageOrdinal }
            : { status: 'SUBMITTED', stageOrdinal: stageOrdinal + 1 },
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
              endpoint: 'POST /jobs/{jobId}/verify',
              fingerprint,
            },
            { status: 200, body: dtoOut },
          );
        }

        return dtoOut;
      })
      .then(async (dtoOut) => {
        // PR-077 "cancelled on verification" — outside the transaction (`api`
        // schedules/cancels, it never sends, PR-150/151); best-effort, never
        // fails a verify that already committed. Safe no-op if this stage had
        // no escalation configured (`ApprovalRepository
        // #getStageEscalationConfig`'s `escalationHours: null` — nothing was
        // ever scheduled, so `cancelEscalation` finds nothing to remove).
        try {
          await this.notificationQueue.cancelEscalation(jobId, stageOrdinal);
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `escalation cancel failed for job ${jobId} stage ${stageOrdinal}: ${err.message}`,
          );
        }
        // SYS-7 (slice 15-SYSWIRE) — a NON-final verify moves the record into
        // stage N+1's queue, which is the same event submit is for stage 1:
        // schedule the NEXT stage's escalation timer and notify its eligible
        // verifiers (StageEscalationService — best-effort, contains its own
        // failures). Before this call stage 2's escalation_hours config was
        // dead and stage-2 verifiers were never told a record awaited them.
        if (!isFinalStage) {
          await this.stageEscalation.scheduleForStage(jobId, stageOrdinal + 1);
        }
        return dtoOut;
      });
  }

  /**
   * PR-076 delegation resolution. The actor ALWAYS needs their own eligible
   * role for this stage (matches `stageRoleCodes`) — delegation is not a
   * role-bypass mechanism, and the route-level `@Roles()` guard already
   * requires this before this method runs. When `dto.onBehalfOf` is
   * supplied, the actor is additionally claiming to be covering for that
   * (presumably absent) colleague; this claim is only honoured while a
   * currently-active, non-revoked `delegation` row from that colleague TO
   * the actor exists — S-25: an expired/absent/revoked delegation makes the
   * claim itself not permitted, rejected even though the actor could have
   * signed without it.
   */
  private async resolveEligibility(
    actor: ActorMeta,
    roles: string[],
    dto: VerifyJobRequest,
    stageRoleCodes: string[],
  ): Promise<{ matchedRoleCode: string; onBehalfOfId: string | null }> {
    // The actor must hold their OWN eligible role regardless of `onBehalfOf`
    // — the route-level `@Roles('TEAM_LEADER','ENGINEER')` guard (PR-090,
    // deny-by-default) already requires this before this method ever runs,
    // so this is a stage-specific re-check, not a bypass mechanism.
    // Delegation (PR-076) does NOT let an unqualified person sign; it lets a
    // QUALIFIED person truthfully record that they acted in place of a
    // specific absent colleague — which is only permitted while that
    // colleague's delegation to them is currently active (S-25: an expired,
    // revoked, or nonexistent delegation makes the `onBehalfOf` CLAIM itself
    // not permitted, even though the actor could sign without it).
    const matchedRoleCode = roles.find((r) => stageRoleCodes.includes(r));
    if (!matchedRoleCode) {
      throw forbiddenProblem('You do not hold a role eligible for this approval stage.');
    }

    if (!dto.onBehalfOf) {
      return { matchedRoleCode, onBehalfOfId: null };
    }

    const delegation = await this.approvalRepo.findActiveDelegation(
      actor.actorId,
      dto.onBehalfOf,
      new Date(),
    );
    if (!delegation) {
      throw forbiddenProblem(
        'No currently-active delegation from this user permits recording this action on their behalf (S-25).',
      );
    }
    return { matchedRoleCode, onBehalfOfId: dto.onBehalfOf };
  }
}
