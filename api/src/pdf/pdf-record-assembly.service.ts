import { Inject, Injectable } from '@nestjs/common';
import { resolveTemplateTitle } from '@bamform/shared';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { notFoundProblem, pdfNotYetAvailableProblem } from '../common/domain-problems';
import {
  approvalActionFromDb,
  ITEM_STATUS_FROM_DB,
  JOB_STATUS_FROM_DB,
  JUDGEMENT_FROM_DB,
} from '../jobs/job-enums';
import { JOB_FULL_INCLUDE, latestApprovalStep, type JobFullRow } from '../jobs/job-include';
import { PrismaService } from '../prisma/prisma.service';
import {
  itemInScope,
  type PdfChecklistItemInput,
  type PdfMeasurementInput,
  type PdfRecordInput,
  type PdfSignatureInput,
  type PdfStandingContentInput,
  type PdfVoidNoticeInput,
} from './pdf-html-template';

/**
 * Assembles the plain `PdfRecordInput` `pdf-html-template.ts` renders, from
 * the SAME frozen-revision job data every other read path uses
 * (`JOB_FULL_INCLUDE` — slice 6's job/frozen-revision assembly, reused here
 * rather than re-querying) plus the two personal-data decrypts PR-118/
 * UR-057 need: the signatory's name (`app_user.full_name_ct`, the
 * already-accepted `decodeIdentityField` read path — see
 * `delegations.mapper.ts`/`current-user.builder.ts`) and the drawn
 * signature (`approval_step.drawn_signature_ct`, decrypted via the same
 * `FieldEncryptionService` primitive `verification.service.ts` used to
 * encrypt it — see that file's `table: 'approval_step', column:
 * 'drawn_signature_ct'` call).
 *
 * WORKER-side only (needs `FIELD_ENCRYPTION_SERVICE`, which `WorkerModule`
 * pulls in via `CryptoModule` directly — see that module's doc comment).
 *
 * PR-118: the footer digest is `latestApprovalStep(job).contentHash`, the
 * EXACT SAME row `integrity.service.ts#checkIntegrity` treats as "the
 * stored value" for the most recent step — never recomputed here, never a
 * new digest.
 */
@Injectable()
export class PdfRecordAssemblyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  async assemble(recordId: string): Promise<PdfRecordInput> {
    const job = await this.prisma.job.findUnique({
      where: { id: recordId },
      include: JOB_FULL_INCLUDE,
    });
    if (!job) {
      throw notFoundProblem('Record', recordId);
    }
    const latestStep = latestApprovalStep(job);
    if (!latestStep) {
      throw pdfNotYetAvailableProblem(recordId);
    }

    const signatures = await this.buildSignatures(job);
    const voidNotice = await this.buildVoidNotice(job);

    return {
      recordId: job.id,
      jobNumber: job.jobNumber,
      documentNumber: job.templateRevision.formTemplate.documentNumber,
      documentTitle: this.documentTitle(job),
      revisionCode: job.templateRevision.revisionCode,
      assetCode: job.asset.code,
      // Slice A/QA-format Task 2 — one record is one machine; the asset code
      // IS the machine code (`Asset.code`, e.g. `AW02`).
      machineCode: job.asset.code,
      assetDescription: job.asset.description,
      frequency: job.frequency,
      frequencyScope: job.frequencyScope,
      dueOn: job.dueOn.toISOString().slice(0, 10),
      status: JOB_STATUS_FROM_DB[job.status],
      standingContent: (job.templateRevision.standingContent ?? {}) as PdfStandingContentInput,
      checklist: this.buildChecklist(job),
      measurements: this.buildMeasurements(job),
      partsUsed: job.partsUsed.map((p) => ({
        partNo: p.partNo,
        description: p.description,
        quantity: p.quantity.toString(),
        remarks: p.remarks,
      })),
      attachments: job.attachments.map((a) => ({
        originalFilename: a.originalFilename,
        contentType: a.contentType,
      })),
      signatures,
      voidNotice,
      footer: {
        recordId: job.id,
        integrityDigestHex: Buffer.from(latestStep.contentHash).toString('hex'),
        renderedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * The title as it PRINTS on this record, with the blank filled in.
   *
   * Slice 31-TITLEBLANK — the TECHNICIAN's per-record entry
   * (`job.title_machine_number`) wins; the admin-set
   * `asset_document.machine_number` is the fallback, so every record signed
   * before that field existed, and every document an admin has already
   * labelled, keeps printing exactly as it does today.
   *
   * Both go through `resolveTemplateTitle`, which substitutes at RENDER and
   * deliberately leaves the blank intact when there is nothing to write into
   * it — the paper form reads that way too before someone writes on it. The
   * result is `escapeHtml`'d by `pdf-html-template.ts` like every other
   * interpolated string (`esc(input.documentTitle)`), so technician free text
   * containing `&` or `<script>` is escaped, not injected.
   *
   * Whether the title can change after signing is NOT this function's
   * concern and is not left to it: the value it reads is immutable from
   * SUBMIT onwards — `assertJobWritable` refuses every capture route once the
   * job leaves ASSIGNED/IN_PROGRESS, and `prevent_archived_job_update()` is
   * the database backstop for an archived or voided row.
   */
  private documentTitle(job: JobFullRow): string {
    return resolveTemplateTitle(
      job.templateRevision.formTemplate.title,
      job.titleMachineNumber ?? job.assetDocument.machineNumber,
    );
  }

  /**
   * Slice 17-VOID — the PDF must TELL THE TRUTH about a voided record: the
   * untouched signed content renders exactly as before, under a VOID
   * watermark/banner/footer line built from the annotation. The voiding
   * ADMIN's name uses the same `decodeIdentityField` read path as the
   * signature block.
   */
  private async buildVoidNotice(job: JobFullRow): Promise<PdfVoidNoticeInput | null> {
    if (job.status !== 'voided') {
      return null;
    }
    let voidedByName: string | null = null;
    if (job.voidedBy) {
      const user = await this.prisma.appUser.findUnique({
        where: { id: job.voidedBy },
        select: { id: true, fullNameCt: true, dekVersion: true },
      });
      voidedByName = user
        ? decodeIdentityField(
            user.fullNameCt,
            user.dekVersion,
            { column: 'full_name_ct', rowId: user.id },
            this.fieldEncryption,
          )
        : job.voidedBy;
    }
    return {
      reason: job.voidReason,
      voidedAt: job.voidedAt ? job.voidedAt.toISOString() : null,
      voidedByName,
    };
  }

  private buildChecklist(job: JobFullRow): PdfChecklistItemInput[] {
    const itemsById = new Map(job.templateRevision.items.map((i) => [i.id, i]));
    return job.itemResults
      .map((r) => {
        const item = itemsById.get(r.templateItemId);
        // A result whose item fell off the active revision (soft-removed —
        // see `JOB_FULL_INCLUDE`'s `active: true` filter) has no frequency of
        // its own to resolve scope against. Fail CLOSED, the same way a
        // Y-on-6M row is closed: `''` can never appear in a real
        // `frequency_scope` array (`FrequencyT` is `'M1' | 'M3' | 'M6' |
        // 'Y'`), so `itemInScope` below always returns false for this row
        // rather than fabricating a frequency that would force it open.
        const frequency = item?.frequency ?? '';
        return {
          itemNo: item?.itemNo ?? 0,
          frequency,
          inScope: itemInScope(frequency, job.frequencyScope),
          instruction: item?.instruction ?? '(item no longer on the revision)',
          status: ITEM_STATUS_FROM_DB[r.status],
          remark: r.remark,
        };
      })
      .sort((a, b) => a.itemNo - b.itemNo);
  }

  private buildMeasurements(job: JobFullRow): PdfMeasurementInput[] {
    const measurementsById = new Map(job.templateRevision.measurements.map((m) => [m.id, m]));
    return job.measurementResults.map((r) => {
      const tm = measurementsById.get(r.templateMeasurementId);
      return {
        description: tm?.description ?? '(measurement no longer on the revision)',
        unit: tm?.unit ?? null,
        specDisplay: tm?.specDisplay ?? '',
        reading: r.readingNumeric != null ? r.readingNumeric.toString() : r.readingText,
        judgement: JUDGEMENT_FROM_DB[r.judgement],
        remark: r.remark,
      };
    });
  }

  private async buildSignatures(job: JobFullRow): Promise<PdfSignatureInput[]> {
    const userIds = new Set<string>();
    for (const step of job.approvalSteps) {
      userIds.add(step.actorId);
      if (step.onBehalfOfId) userIds.add(step.onBehalfOfId);
    }
    const users = await this.prisma.appUser.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, fullNameCt: true, dekVersion: true },
    });
    const nameById = new Map(
      users.map((u) => [
        u.id,
        decodeIdentityField(
          u.fullNameCt,
          u.dekVersion,
          { column: 'full_name_ct', rowId: u.id },
          this.fieldEncryption,
        ),
      ]),
    );

    return job.approvalSteps.map((step) => {
      const drawnSignatureBase64 =
        step.drawnSignatureCt && step.drawnSignatureDekVersion != null
          ? this.fieldEncryption.decrypt(step.drawnSignatureCt, step.drawnSignatureDekVersion, {
              table: 'approval_step',
              column: 'drawn_signature_ct',
              rowId: step.id,
            })
          : null;

      return {
        approvalStepId: step.id,
        stageOrdinal: step.stageOrdinal,
        // Slice 26-TWOSTAGE M1 — read from the STEP, never joined from
        // `approval_stage`: the caption an auditor reads must be the one that
        // was true when the signature was taken.
        stageLabel: step.stageLabel,
        action: approvalActionFromDb(step.action),
        actorName: nameById.get(step.actorId) ?? step.actorId,
        actorRoleCode: step.actorRoleCode,
        actedAt: step.actedAt.toISOString(),
        onBehalfOfName: step.onBehalfOfId ? (nameById.get(step.onBehalfOfId) ?? null) : null,
        reason: step.reason,
        drawnSignatureBase64,
      };
    });
  }
}
