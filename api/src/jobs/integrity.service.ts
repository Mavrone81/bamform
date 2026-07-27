import { Inject, Injectable } from '@nestjs/common';
import { JobStatusT } from '@prisma/client';
import type { IntegrityResult } from '@bamform/shared';
import { notFoundProblem } from '../common/domain-problems';
import { computeContentHash } from '../crypto/content-hash';
import { RECORD_SIGNING_SERVICE } from '../crypto/crypto.tokens';
import type { RecordSigningService } from '../crypto/record-signer';
import { PrismaService } from '../prisma/prisma.service';
import { buildCanonicalJobRecord } from './canonical-job-record';
import { JobAccessService } from './job-access';
import { JOB_STATUS_FROM_DB, JUDGEMENT_FROM_DB } from './job-enums';
import { JOB_FULL_INCLUDE, type JobFullRow } from './job-include';

/**
 * PR-095/AC-11/ADR-010 — `GET /records/{id}/integrity`: "Recomputes the
 * canonical serialisation from current data, re-derives the digest, compares
 * it to the stored value and verifies the Ed25519 signature."
 *
 * SCOPE NOTE (documented, not a silent gap — see slice-7-report.md): item/
 * measurement/part/attachment rows are frozen only from the moment a job is
 * `SUBMITTED` onward for its CURRENT episode — a `return` sends it back to
 * `IN_PROGRESS`, where results are legitimately editable again for rework
 * (PR-045's writable-status gate). That means an EARLIER approval_step's
 * exact historical record state is not always reproducible from current
 * data (a superseded `returned` step's content, by definition, differed
 * from what's there now). `hashMatches` is therefore computed exactly for
 * the MOST RECENT approval_step only, where "current data" IS, by
 * definition, the data at signing time (nothing can have changed since the
 * newest step without creating a newer step). `signatureValid` — the
 * cryptographic self-consistency of each step's OWN stored
 * `content_hash`/`signature` pair against the record-signing public key — is
 * still checked for EVERY step; this alone detects direct-DB tampering with
 * either field (S-10's attack shape).
 */
@Injectable()
export class IntegrityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECORD_SIGNING_SERVICE) private readonly recordSigner: RecordSigningService,
    private readonly access: JobAccessService,
  ) {}

  async checkIntegrity(
    recordId: string,
    actor: { userId: string; roles: string[] },
  ): Promise<IntegrityResult> {
    const job = await this.prisma.job.findUnique({
      where: { id: recordId },
      include: JOB_FULL_INCLUDE,
    });
    if (!job) {
      throw notFoundProblem('Record', recordId);
    }

    // SYS-9 (slice 15-SYSWIRE) — object-level authorisation. This was the
    // one record read that never received the caller: any authenticated user
    // could probe arbitrary UUIDs and learn record existence, approval-step
    // ids/timestamps, signingKeyId and mismatchDetail (IDOR). Same contour
    // as every sibling job/record read: 403 out-of-scope (area), 403
    // forbidden (MAINTAINER and not the assignee — "View archive: own",
    // §4.1). `JobAccessService` rather than `RecordsService#assertAccessible`
    // because integrity legitimately serves NON-archived jobs too (a
    // submitted record's steps are checkable) and the two rules are
    // identical for the roles involved; RecordsService lives in a module
    // that imports THIS one, so using it here would create an import cycle.
    await this.access.assertAccessible(actor, {
      assignedTo: job.assignedTo,
      areaId: job.asset.areaId,
    });

    const steps = job.approvalSteps;
    const mismatches: string[] = [];

    const signatures = steps.map((step, index) => {
      const signatureValid = this.recordSigner.verify(
        Buffer.from(step.contentHash),
        Buffer.from(step.signature),
      );
      if (!signatureValid) {
        mismatches.push(
          `approval_step ${step.id}: signature does not verify against its stored content_hash.`,
        );
      }

      const isMostRecent = index === steps.length - 1;
      let hashMatches: boolean | undefined;
      if (isMostRecent) {
        const recomputed = computeContentHash(buildCurrentCanonicalRecord(job));
        hashMatches = recomputed.equals(Buffer.from(step.contentHash));
        if (!hashMatches) {
          mismatches.push(
            `approval_step ${step.id}: recomputed content hash does not match the stored value — the record may have been altered since this signature.`,
          );
        }
      }

      return {
        approvalStepId: step.id,
        actedAt: step.actedAt.toISOString(),
        signingKeyId: step.signingKeyId,
        hashMatches: hashMatches ?? true,
        signatureValid,
      };
    });

    const intact = mismatches.length === 0;
    // Slice 17-VOID — truthfulness for a voided record: `intact` speaks ONLY
    // to cryptographic integrity (the content never changed, so signatures
    // still verify), while `voided` states the record's standing. Both are
    // reported; neither masks the other.
    const voided = job.status === JobStatusT.voided;
    return {
      recordId,
      intact,
      checkedAt: new Date().toISOString(),
      voided,
      voidReason: voided ? job.voidReason : null,
      voidedAt: voided && job.voidedAt ? job.voidedAt.toISOString() : null,
      signatures,
      mismatchDetail: intact ? null : mismatches.join(' '),
    };
  }
}

function buildCurrentCanonicalRecord(job: JobFullRow) {
  return buildCanonicalJobRecord({
    job: {
      id: job.id,
      jobNumber: job.jobNumber,
      assetId: job.assetId,
      templateRevisionId: job.templateRevisionId,
      frequency: job.frequency,
      status: JOB_STATUS_FROM_DB[job.status],
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
    approvalSteps: job.approvalSteps.map((s) => ({
      id: s.id,
      stageOrdinal: s.stageOrdinal,
      action: s.action,
      actorId: s.actorId,
      onBehalfOfId: s.onBehalfOfId,
      reason: s.reason,
      actedAt: s.actedAt,
    })),
  });
}
