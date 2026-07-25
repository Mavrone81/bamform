import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  returnJobRequestSchema,
  verifyJobRequestSchema,
  voidJobRequestSchema,
  type ReturnJobRequest,
  type VerifyJobRequest,
  type VoidJobRequest,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StepUpGuard } from '../auth/guards/step-up.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalTransitionsService } from './approval-transitions.service';
import { VerificationService } from './verification.service';

/**
 * PR-041..046/070..077/093/094/ADR-013 — approval transitions as POST
 * sub-resources: `/jobs/{id}/verify`, `/return`, `/recall`, `/void`.
 * `@Controller('jobs')` (not a separate `/approval` prefix) — matches
 * `api/openapi.yaml`'s `/jobs/{jobId}/...` paths exactly, mirroring
 * `JobsController`/`AttachmentsController`'s "one module, several focused
 * controllers" convention (`jobs.module.ts`).
 */
@Controller('jobs')
@UseGuards(RolesGuard)
export class ApprovalController {
  constructor(
    private readonly verification: VerificationService,
    private readonly transitions: ApprovalTransitionsService,
    private readonly prisma: PrismaService,
  ) {}

  /** PR-API-07: requires step-up (StepUpGuard) — a signing action. Permission matrix §4.1: TEAM_LEADER/ENGINEER. */
  @Post(':jobId/verify')
  @Roles('TEAM_LEADER', 'ENGINEER')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  async verify(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(verifyJobRequestSchema)) dto: VerifyJobRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    // StepUpGuard already asserted freshness; re-read here so the evidence
    // persisted on approval_step.step_up_verified_at (PR-091) is the ACTUAL
    // verified timestamp, not merely "now" (a guard pass a few ms ago).
    const appUser = await this.prisma.appUser.findUniqueOrThrow({ where: { id: user.sub } });
    return this.verification.verify(
      jobId,
      dto,
      idempotencyKey,
      appUser.lastAuthenticatedAt!,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  /** Permission matrix §4.1: TEAM_LEADER/ENGINEER. */
  @Post(':jobId/return')
  @Roles('TEAM_LEADER', 'ENGINEER')
  @HttpCode(HttpStatus.OK)
  return_(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(returnJobRequestSchema)) dto: ReturnJobRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.transitions.return_(
      jobId,
      dto,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  /** PR-075/UR-051: submitter only (service-enforced), while SUBMITTED. Route-gated the same as record capture. */
  @Post(':jobId/recall')
  @Roles('MAINTAINER', 'TEAM_LEADER', 'ENGINEER')
  @HttpCode(HttpStatus.OK)
  recall(
    @Param('jobId') jobId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.transitions.recall(
      jobId,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  /** Permission matrix §4.1: TEAM_LEADER/ENGINEER/ADMIN. */
  @Post(':jobId/void')
  @Roles('TEAM_LEADER', 'ENGINEER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  void_(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(voidJobRequestSchema)) dto: VoidJobRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.transitions.void_(
      jobId,
      dto,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }
}
