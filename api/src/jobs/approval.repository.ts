import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApprovalActionT, Prisma } from '@prisma/client';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import { toBytes } from '../common/prisma-bytes';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';

export interface ApprovalStageWithRoles {
  id: string;
  stageOrdinal: number;
  label: string;
  roleCodes: string[];
}

export interface CreateApprovalStepData {
  id: string;
  jobId: string;
  stageOrdinal: number;
  /**
   * Slice 26-TWOSTAGE M1 — `approval_stage.label` captured HERE, in the
   * signing transaction, so the archived record's caption can never be
   * rewritten by a later administrative relabel. `null` for actions whose
   * caption is derived from the action itself (submission, return, recall,
   * void) rather than from route configuration.
   */
  stageLabel: string | null;
  action: ApprovalActionT;
  actorId: string;
  onBehalfOfId: string | null;
  actorRoleCode: string;
  reason: string | null;
  actedAt: Date;
  sourceIp?: string;
  contentHash: Buffer;
  signature: Buffer;
  signingKeyId: string;
  stepUpVerifiedAt: Date | null;
  drawnSignatureCt: Buffer | null;
  drawnSignatureDekVersion: number | null;
}

/**
 * DB access for ADR-011's route-as-data model (`approval_route` ->
 * `approval_stage` -> `approval_stage_role`) and PR-076's delegation
 * resolution — kept separate from `VerificationService`/
 * `ApprovalTransitionsService` (which own the business rules) so the
 * Prisma-shaped queries live in one reviewable place, mirroring
 * `jobs.repository.ts`.
 */
@Injectable()
export class ApprovalRepository {
  private readonly logger = new Logger(ApprovalRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  async getStageWithRoles(
    approvalRouteId: string,
    stageOrdinal: number,
  ): Promise<ApprovalStageWithRoles | null> {
    const stage = await this.prisma.approvalStage.findUnique({
      where: { approvalRouteId_stageOrdinal: { approvalRouteId, stageOrdinal } },
      include: { stageRoles: { include: { role: true } } },
    });
    if (!stage) {
      return null;
    }
    return {
      id: stage.id,
      stageOrdinal: stage.stageOrdinal,
      label: stage.label,
      roleCodes: stage.stageRoles.map((sr) => sr.role.code),
    };
  }

  async getStageCount(approvalRouteId: string): Promise<number> {
    return this.prisma.approvalStage.count({ where: { approvalRouteId } });
  }

  /**
   * PR-077's escalation config for one stage. `escalationHours: null` is a
   * distinct, deliberate "no escalation for this stage" state — NOT "use a
   * system default". Callers (`SubmissionService`/`VerificationService`) must
   * not schedule an escalation job when this returns `escalationHours: null`.
   *
   * The DELIVERED route no longer relies on that null state: migration
   * `20260726120000_enable_verification_escalation_default` sets 72 hours on
   * both stages of `TWO_STAGE_TL_THEN_ENG` (UR-050 — Samuel, 2026-07-26,
   * resolving the slice-11a finding-D contradiction between
   * `ENVIRONMENT_REQUIREMENTS.md`'s advertised 72h default and the original
   * seed's "escalation off"). Clearing a stage's value still switches
   * escalation off for that stage, which is why the null branch stays.
   */
  async getStageEscalationConfig(
    approvalRouteId: string,
    stageOrdinal: number,
  ): Promise<{ escalationHours: number | null; escalateToRoleCode: string | null } | null> {
    const stage = await this.prisma.approvalStage.findUnique({
      where: { approvalRouteId_stageOrdinal: { approvalRouteId, stageOrdinal } },
      include: { escalateToRole: true },
    });
    if (!stage) {
      return null;
    }
    return {
      escalationHours: stage.escalationHours,
      escalateToRoleCode: stage.escalateToRole?.code ?? null,
    };
  }

  /**
   * PR-076: a non-revoked delegation from `delegatorId` to `delegateId` whose
   * window (`valid_from`..`valid_to`) contains `now`. Returns `null` (not
   * found/expired/revoked) when acting under delegation is NOT currently
   * permitted — S-25's "act under an expired delegation — not permitted".
   */
  async findActiveDelegation(
    delegateId: string,
    delegatorId: string,
    now: Date,
  ): Promise<{ id: string } | null> {
    return this.prisma.delegation.findFirst({
      where: {
        delegateId,
        delegatorId,
        revokedAt: null,
        validFrom: { lte: now },
        validTo: { gt: now },
      },
      select: { id: true },
    });
  }

  /** All approval steps for a job, oldest first — used to build the canonical record's `approvalSteps`. */
  listApprovalSteps(jobId: string, tx: Prisma.TransactionClient = this.prisma) {
    return tx.approvalStep.findMany({ where: { jobId }, orderBy: { actedAt: 'asc' } });
  }

  /**
   * INV-09 — the signatory's name AS IT READS NOW, re-encrypted under this
   * step's own AAD, so the archived record keeps the name that was true when
   * the signature was taken.
   *
   * Done HERE, at the single `approval_step` creation site, rather than in the
   * three services that call it: a caller cannot forget it, and every action
   * (submit, verify, return, recall, void) is covered by construction.
   *
   * FAIL-SOFT, but only over the operations that can genuinely be soft. A name
   * that cannot be READ — a row whose ciphertext predates the current key, or
   * any decrypt/encrypt failure — must never block a signature: capture is the
   * point of the system, and a missing snapshot degrades exactly to the
   * pre-existing behaviour (`buildSignatures` falls back to the live lookup, as
   * it does for every row written before this column existed). Those are
   * pure-CPU operations, so swallowing them is safe.
   *
   * The `findMany` is deliberately OUTSIDE that catch. A Prisma error inside an
   * interactive transaction has already aborted the Postgres transaction, so
   * swallowing it would not degrade anything — it would just make the
   * `approvalStep.create` below fail with a confusing `25P02` (current
   * transaction is aborted) instead of the real error. A DB failure here is a
   * DB failure of the signing transaction, and must surface as one.
   */
  private async snapshotSignatoryNames(
    tx: Prisma.TransactionClient,
    data: CreateApprovalStepData,
  ): Promise<{
    actorNameCt: Prisma.Bytes | null;
    onBehalfOfNameCt: Prisma.Bytes | null;
    signatoryNameDekVersion: number | null;
  }> {
    const none = { actorNameCt: null, onBehalfOfNameCt: null, signatoryNameDekVersion: null };

    // Not in the try: see the note above — a failure here is not soft.
    const ids = [data.actorId, ...(data.onBehalfOfId ? [data.onBehalfOfId] : [])];
    const users = await tx.appUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullNameCt: true, dekVersion: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    try {
      const encodeFor = (
        userId: string | null,
        column: 'actor_name_ct' | 'on_behalf_of_name_ct',
      ) => {
        if (!userId) return null;
        const user = byId.get(userId);
        if (!user) return null;
        const plaintext = decodeIdentityField(
          user.fullNameCt,
          user.dekVersion,
          { column: 'full_name_ct', rowId: user.id },
          this.fieldEncryption,
        );
        // Re-encrypted under THIS step's context: AAD binds the ciphertext to
        // ('approval_step', column, step id), so it cannot be lifted onto
        // another step or another column and still decrypt.
        return this.fieldEncryption.encrypt(plaintext, {
          table: 'approval_step',
          column,
          rowId: data.id,
        });
      };

      const actor = encodeFor(data.actorId, 'actor_name_ct');
      const onBehalf = encodeFor(data.onBehalfOfId, 'on_behalf_of_name_ct');
      if (!actor && !onBehalf) {
        return none;
      }
      return {
        actorNameCt: actor ? toBytes(actor.ciphertext) : null,
        onBehalfOfNameCt: onBehalf ? toBytes(onBehalf.ciphertext) : null,
        signatoryNameDekVersion: (actor ?? onBehalf)!.dekVersion,
      };
    } catch (error) {
      this.logger.warn(
        `approval step ${data.id}: signatory name not snapshotted (${
          error instanceof Error ? error.name : 'unknown error'
        }); the record will render the live name until this is corrected`,
      );
      return none;
    }
  }

  async createApprovalStep(tx: Prisma.TransactionClient, data: CreateApprovalStepData) {
    const names = await this.snapshotSignatoryNames(tx, data);
    return tx.approvalStep.create({
      data: {
        id: data.id,
        jobId: data.jobId,
        stageOrdinal: data.stageOrdinal,
        stageLabel: data.stageLabel,
        actorNameCt: names.actorNameCt,
        onBehalfOfNameCt: names.onBehalfOfNameCt,
        signatoryNameDekVersion: names.signatoryNameDekVersion,
        action: data.action,
        actorId: data.actorId,
        onBehalfOfId: data.onBehalfOfId,
        actorRoleCode: data.actorRoleCode,
        reason: data.reason,
        actedAt: data.actedAt,
        sourceIp: data.sourceIp,
        contentHash: toBytes(data.contentHash),
        signature: toBytes(data.signature),
        signingKeyId: data.signingKeyId,
        stepUpVerifiedAt: data.stepUpVerifiedAt,
        drawnSignatureCt: data.drawnSignatureCt ? toBytes(data.drawnSignatureCt) : null,
        drawnSignatureDekVersion: data.drawnSignatureDekVersion,
      },
    });
  }
}
