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
  itemResultInputSchema,
  measurementResultInputSchema,
  partUsedInputSchema,
  type ItemResultInput,
  type MeasurementResultInput,
  type PartUsedInput,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
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

  @Get(':jobId')
  get(@Param('jobId') jobId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.jobs.get(user.sub, user.roles, jobId);
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

  @Post(':jobId/submit')
  @Roles(...JOB_RECORD_ROLES)
  @HttpCode(HttpStatus.OK)
  submit(
    @Param('jobId') jobId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.submission.submit(
      jobId,
      idempotencyKey,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }
}
