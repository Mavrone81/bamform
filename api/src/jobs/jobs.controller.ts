import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  assignJobRequestSchema,
  createAdhocJobRequestSchema,
  itemResultInputSchema,
  measurementResultInputSchema,
  partUpsertInputSchema,
  partUsedInputSchema,
  submitJobRequestSchema,
  type AssignJobRequest,
  type CreateAdhocJobRequest,
  type ItemResultInput,
  type MeasurementResultInput,
  type PartUpsertInput,
  type PartUsedInput,
  type SubmitJobRequest,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdhocJobService } from './adhoc-job.service';
import { AssignmentService } from './assignment.service';
import { JOB_RECORD_ROLES } from './job-access';
import { JobsService } from './jobs.service';
import { PartsService } from './parts.service';
import { ResultsService } from './results.service';
import { SubmissionService } from './submission.service';

/**
 * PR-030..033/045 — job read/list, result/part capture, submission gate.
 * Matches `api/openapi.yaml` `/jobs*` paths exactly (attachment routes live
 * in `attachments.controller.ts`, same module, per the brief's "focused
 * modules" guidance).
 */
@Controller('jobs')
@UseGuards(RolesGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly results: ResultsService,
    private readonly parts: PartsService,
    private readonly submission: SubmissionService,
    private readonly assignment: AssignmentService,
    private readonly adhoc: AdhocJobService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('assetId') assetId?: string,
    @Query('overdue') overdue?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
  ) {
    return this.jobs.list(user.sub, user.roles, {
      limit,
      cursor,
      status,
      assignedTo,
      assetId,
      overdue: overdue === undefined ? undefined : overdue === 'true',
      dueFrom,
      dueTo,
    });
  }

  /**
   * UR-028/PR-058 — raise a job OFF-PLAN (slice 18-WORKFLOW §2). Declared
   * before the `:jobId` routes purely for readability; Nest matches on the
   * HTTP method too, and no other single-segment `POST /jobs/*` exists.
   *
   * Roles: PLANNER (new, slice 18) plus TEAM_LEADER/ENGINEER/ADMIN — the
   * roles that already manage the schedule and the team. ADDITIVE: no role
   * loses anything.
   */
  @Post('adhoc')
  @Roles('PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  createAdhoc(
    @Body(new ZodValidationPipe(createAdhocJobRequestSchema)) dto: CreateAdhocJobRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.adhoc.create(dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Get(':jobId')
  get(@Param('jobId') jobId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.jobs.get(user.sub, user.roles, jobId);
  }

  /**
   * UR-029 — assignment/reassignment. Permission matrix §4.1 has no
   * dedicated row; TL/ENG/ADMIN per the review-confirmed intent (SYS-2) —
   * the roles that manage the schedule and the team. Slice 18-WORKFLOW adds
   * PLANNER: planning work and handing it to someone are the same job.
   * ADDITIVE — TL/ENG/ADMIN keep exactly the right they had.
   */
  @Post(':jobId/assign')
  @Roles('PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(assignJobRequestSchema)) dto: AssignJobRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.assignment.assign(
      jobId,
      dto,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  @Put(':jobId/items/:templateItemId')
  @Roles(...JOB_RECORD_ROLES)
  recordItemResult(
    @Param('jobId') jobId: string,
    @Param('templateItemId') templateItemId: string,
    @Body(new ZodValidationPipe(itemResultInputSchema)) dto: ItemResultInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.results.recordItemResult(
      jobId,
      templateItemId,
      dto,
      { idempotencyKey, ifMatch },
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  @Put(':jobId/measurements/:templateMeasurementId')
  @Roles(...JOB_RECORD_ROLES)
  recordMeasurementResult(
    @Param('jobId') jobId: string,
    @Param('templateMeasurementId') templateMeasurementId: string,
    @Body(new ZodValidationPipe(measurementResultInputSchema)) dto: MeasurementResultInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.results.recordMeasurementResult(
      jobId,
      templateMeasurementId,
      dto,
      { idempotencyKey, ifMatch },
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  @Post(':jobId/parts')
  @Roles(...JOB_RECORD_ROLES)
  @HttpCode(HttpStatus.CREATED)
  recordPart(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(partUsedInputSchema)) dto: PartUsedInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.parts.recordPart(
      jobId,
      dto,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  /**
   * Slice 30 — client-keyed create-or-update, additive to the `POST` above.
   * `active: false` is the soft-remove path (non-negotiable #7: no physical
   * `DELETE`).
   */
  @Put(':jobId/parts/:partId')
  @Roles(...JOB_RECORD_ROLES)
  upsertPart(
    @Param('jobId') jobId: string,
    @Param('partId') partId: string,
    @Body(new ZodValidationPipe(partUpsertInputSchema)) dto: PartUpsertInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.parts.upsertPart(
      jobId,
      partId,
      dto,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }

  /**
   * Slice 18-WORKFLOW §1 — submit now carries the PERFORMER's drawn
   * signature (`SubmitJobRequest.drawnSignature`, mandatory). The role gate
   * is unchanged: the people who record results are the people who sign for
   * them.
   */
  @Post(':jobId/submit')
  @Roles(...JOB_RECORD_ROLES)
  @HttpCode(HttpStatus.OK)
  submit(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(submitJobRequestSchema)) dto: SubmitJobRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.submission.submit(
      jobId,
      dto,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }
}
