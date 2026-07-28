import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApprovalActionT, AuditActionT, JobStatusT } from '@prisma/client';
import type { Job, SubmitJobRequest } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import {
  forbiddenProblem,
  incompleteRecordProblem,
  invalidTransitionProblem,
} from '../common/domain-problems';
import { IdempotencyService } from '../common/idempotency.service';
import { computeContentHash } from '../crypto/content-hash';
import { FIELD_ENCRYPTION_SERVICE, RECORD_SIGNING_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import type { RecordSigningService } from '../crypto/record-signer';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalRepository } from './approval.repository';
import { buildCanonicalJobRecord } from './canonical-job-record';
import { decodeAndValidateDrawnSignature } from './drawn-signature';
import { JOB_RECORD_ROLES } from './job-access';
import { JOB_STATUS_FROM_DB, JUDGEMENT_FROM_DB } from './job-enums';
import { JOB_FULL_INCLUDE } from './job-include';
import { JobsService } from './jobs.service';
import { toJob } from './mappers';
import { StageEscalationService } from './stage-escalation.service';
import { findOutstandingMandatoryItems } from './submission-gate';

const FIRST_STAGE = 1;

/**
 * The stage ordinal the PERFORMER's signature is recorded at (slice
 * 18-WORKFLOW §1). Zero, deliberately: verification stages are 1..N
 * (`approval_stage.stage_ordinal`, ADR-011), and the performer's signature
 * is not a verification stage — it is the assertion that precedes stage 1.
 * Numbering it 0 keeps every existing stage calculation
 * (`currentStageOrdinal`, `getStageWithRoles`, the queue) untouched while
 * putting the signature in the one place that already carries a
 * content-bound signature, a drawn signature and an actor.
 */
const PERFORMER_STAGE = 0;

/**
 * PR-045/UR-039/ADR-013 — the submission completeness gate.
 * `POST /jobs/{id}/submit` is a SEPARATE atomic POST sub-resource
 * (non-negotiable #2/#11), never part of an outbox batch, rejected unless
 * every `mandatory` item on the frozen revision has an `item_result`.
 *
 * SLICE 18-WORKFLOW §1 — submit now also CAPTURES THE PERFORMER'S DRAWN
 * SIGNATURE. The owner's process, step 3: "Completed work — team member will
 * sign and submit to team lead for checks". It is stored as a stage-0
 * `approval_step` with `action = 'submitted'`, using the EXACT mechanism
 * slice 7 built for verifiers and reusing every part of it:
 *
 *   - `decodeAndValidateDrawnSignature` (PNG magic-byte content sniff,
 *     size-bounded), run BEFORE the transaction opens, exactly as
 *     `VerificationService` does;
 *   - `FieldEncryptionService.encrypt` with AAD bound to
 *     (`approval_step`, `drawn_signature_ct`, the step's own id), and the
 *     `dek_version` recorded alongside;
 *   - `buildCanonicalJobRecord` + `computeContentHash` + Ed25519
 *     `RecordSigningService.sign`, so the signature is CONTENT-BOUND: it
 *     commits to the record as submitted, including the performer's own
 *     step (id/actor/actedAt), which is what stops it being replayed under
 *     another identity. A signature that does not commit to what was signed
 *     is decoration.
 *
 * The bytes never leave that encrypted column: they are not logged, not
 * mapped into any read DTO (`mappers.ts#toApprovalStep` maps neither
 * `drawnSignatureCt` nor its dek version) and never enter an audit payload
 * (CR-5). The PDF decrypts them at render time through the same path the
 * verifier signatures already use, so the performer's signature appears
 * alongside theirs with no new plumbing.
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
    private readonly approvalRepo: ApprovalRepository,
    private readonly audit: AuditEventService,
    private readonly idempotency: IdempotencyService,
    private readonly stageEscalation: StageEscalationService,
    @Inject(RECORD_SIGNING_SERVICE) private readonly recordSigner: RecordSigningService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  async submit(
    jobId: string,
    dto: SubmitJobRequest,
    idempotencyKey: string | undefined,
    actor: ActorMeta,
    roles: string[],
  ): Promise<Job> {
    let fingerprint: Buffer | undefined;
    if (idempotencyKey) {
      // THE SIGNATURE IS DELIBERATELY *NOT* IN THE FINGERPRINT — unlike
      // `VerificationService`, which does include it. Slice 18-WORKFLOW's
      // review, finding X-2.
      //
      // Submit is the one endpoint whose idempotency key is PERSISTED across
      // attempts: `web/src/offline/sync-engine.ts` stores
      // `job.submitIdempotencyKey` BEFORE the request and deliberately KEEPS
      // it when the transport throws, so a retry after a LOST RESPONSE
      // replays the committed submission instead of colliding with it
      // (PR-062/SYS-14 — the mechanism the project built for exactly this).
      // And by design the drawn signature is never persisted on the device
      // (it is personal data, and a shared plant tablet is the wrong place
      // for it), so the retry necessarily carries FRESHLY DRAWN — therefore
      // different — PNG bytes.
      //
      // With the signature in the fingerprint, that retry 422'd
      // `/errors/idempotency-mismatch`: a record that had COMMITTED
      // server-side told the technician "the server rejected this
      // submission" and reset to unsent locally, so they redid work that
      // already existed. A different signature on a retry is the EXPECTED
      // case here, not a client defect.
      //
      // Safety of leaving it out: the replay returns the CACHED response and
      // writes nothing — no approval step, no encryption, no audit event. The
      // second signature is discarded, never stored, so it cannot substitute
      // for the one that was content-bound and signed. `jobId` + the actor
      // (`checkReplay` scopes by `actor.actorId`) + a key the client minted
      // for this one submission already identify the request completely.
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

    // The role the performer is signing AS — recorded on the step so the
    // PDF's signature block can state it, exactly as it does for verifiers.
    // The route-level `@Roles(...JOB_RECORD_ROLES)` guard already required
    // one of these, so this is a lookup, not a second gate; the throw is a
    // defensive impossibility, not a live code path.
    const actorRoleCode = roles.find((role) => JOB_RECORD_ROLES.includes(role));
    if (!actorRoleCode) {
      throw forbiddenProblem('You do not hold a role that can record and submit results.');
    }

    // Content validation BEFORE opening the transaction — an S-30-style
    // content check should never depend on a DB round trip having started
    // (and a rejected signature must leave neither a state change nor an
    // audit event behind).
    const drawnPng = decodeAndValidateDrawnSignature(dto.drawnSignature);

    const approvalStepId = randomUUID();
    const now = new Date();

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
            submittedAt: now,
            submittedBy: actor.actorId,
            currentStageOrdinal: 1,
          },
        });
        if (guarded.count === 0) {
          throw invalidTransitionProblem(
            'This job changed state before the submission could be applied — reload and retry.',
          );
        }

        // Every step already on this job (a previous cycle's submit/verify/
        // return) PLUS the one being created — the same self-binding shape
        // `VerificationService` builds, so a signature can never be replayed
        // under a different approval_step identity.
        const priorSteps = await this.approvalRepo.listApprovalSteps(jobId, tx);
        const canonicalRecord = buildCanonicalJobRecord({
          job: {
            id: job.id,
            jobNumber: job.jobNumber,
            assetId: job.assetId,
            templateRevisionId: job.templateRevisionId,
            frequency: job.frequency,
            status: JOB_STATUS_FROM_DB[JobStatusT.submitted],
          },
          templateRevision: {
            id: job.templateRevision.id,
            formTemplateId: job.templateRevision.formTemplateId,
            revisionCode: job.templateRevision.revisionCode,
            sequenceOrdinal: job.templateRevision.sequenceOrdinal,
          },
          submitter: { userId: actor.actorId, submittedAt: now },
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
              stageOrdinal: PERFORMER_STAGE,
              action: ApprovalActionT.submitted,
              actorId: actor.actorId,
              onBehalfOfId: null,
              reason: null,
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
          stageOrdinal: PERFORMER_STAGE,
          action: ApprovalActionT.submitted,
          actorId: actor.actorId,
          onBehalfOfId: null,
          actorRoleCode,
          reason: null,
          actedAt: now,
          sourceIp: actor.sourceIp,
          contentHash,
          signature,
          signingKeyId: this.recordSigner.kid,
          // Submit requires authentication, not step-up: the performer is
          // asserting their own work, not approving someone else's (only
          // `/verify` and `/revisions/{id}/approve` carry PR-091 step-up).
          stepUpVerifiedAt: null,
          drawnSignatureCt: encryptedDrawn.ciphertext,
          drawnSignatureDekVersion: encryptedDrawn.dekVersion,
        });

        // CR-5: the audit payload carries the STATE CHANGE only. The
        // signature bytes exist in exactly one place — the encrypted column
        // written above — and never here.
        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.state_change,
          entityType: 'job',
          entityId: jobId,
          before: { status: 'IN_PROGRESS' },
          after: { status: 'SUBMITTED', performerSignatureStepId: approvalStepId },
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
