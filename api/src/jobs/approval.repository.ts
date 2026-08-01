import { Injectable } from '@nestjs/common';
import type { ApprovalActionT, Prisma } from '@prisma/client';
import { toBytes } from '../common/prisma-bytes';
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
  constructor(private readonly prisma: PrismaService) {}

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

  async createApprovalStep(tx: Prisma.TransactionClient, data: CreateApprovalStepData) {
    return tx.approvalStep.create({
      data: {
        id: data.id,
        jobId: data.jobId,
        stageOrdinal: data.stageOrdinal,
        stageLabel: data.stageLabel,
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
