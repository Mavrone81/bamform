import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createRevisionRequestSchema,
  patchRevisionRequestSchema,
  rejectRevisionRequestSchema,
  replaceItemsRequestSchema,
  replaceMeasurementsRequestSchema,
  type CreateRevisionRequest,
  type PatchRevisionRequest,
  type RejectRevisionRequest,
  type ReplaceItemsRequest,
  type ReplaceMeasurementsRequest,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StepUpGuard } from '../auth/guards/step-up.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RevisionsService } from './revisions.service';

/**
 * PR-022..028, PR-047..049 — template revision lifecycle. Only
 * `createRevision`/`replaceRevisionMeasurements`/`approveRevision` are in
 * `api/openapi.yaml`; `PATCH /revisions/{id}`, `PUT .../items`,
 * `POST .../submit` and `POST .../reject` are not (slice-4-report.md flags
 * this) — shapes here follow API_SPECIFICATION.md §10.4 and
 * WORKFLOW_DIAGRAMS.md §15.
 */
@Controller()
@UseGuards(RolesGuard)
export class RevisionsController {
  constructor(private readonly revisions: RevisionsService) {}

  @Get('templates/:templateId/revisions')
  listForTemplate(@Param('templateId') templateId: string) {
    return this.revisions.listForTemplate(templateId);
  }

  @Post('templates/:templateId/revisions')
  @Roles('ENGINEER', 'DOC_CONTROLLER')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('templateId') templateId: string,
    @Body(new ZodValidationPipe(createRevisionRequestSchema)) dto: CreateRevisionRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.create(templateId, dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Get('revisions/:revisionId')
  get(@Param('revisionId') revisionId: string) {
    return this.revisions.get(revisionId);
  }

  @Patch('revisions/:revisionId')
  @Roles('ENGINEER', 'DOC_CONTROLLER')
  patch(
    @Param('revisionId') revisionId: string,
    @Body(new ZodValidationPipe(patchRevisionRequestSchema)) dto: PatchRevisionRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.patch(revisionId, dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Put('revisions/:revisionId/items')
  @Roles('ENGINEER', 'DOC_CONTROLLER')
  replaceItems(
    @Param('revisionId') revisionId: string,
    @Body(new ZodValidationPipe(replaceItemsRequestSchema)) dto: ReplaceItemsRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.replaceItems(revisionId, dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Put('revisions/:revisionId/measurements')
  @Roles('ENGINEER', 'DOC_CONTROLLER')
  replaceMeasurements(
    @Param('revisionId') revisionId: string,
    @Body(new ZodValidationPipe(replaceMeasurementsRequestSchema)) dto: ReplaceMeasurementsRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.replaceMeasurements(revisionId, dto, {
      actorId: user.sub,
      ...requestMeta(req),
    });
  }

  @Post('revisions/:revisionId/submit')
  @Roles('ENGINEER', 'DOC_CONTROLLER')
  @HttpCode(HttpStatus.OK)
  submit(
    @Param('revisionId') revisionId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.submit(revisionId, { actorId: user.sub, ...requestMeta(req) });
  }

  /** PR-API-07: requires step-up (StepUpGuard) — signing action. */
  @Post('revisions/:revisionId/approve')
  @Roles('DOC_CONTROLLER')
  @UseGuards(StepUpGuard)
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('revisionId') revisionId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.approve(revisionId, { actorId: user.sub, ...requestMeta(req) });
  }

  @Post('revisions/:revisionId/reject')
  @Roles('DOC_CONTROLLER')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('revisionId') revisionId: string,
    @Body(new ZodValidationPipe(rejectRevisionRequestSchema)) dto: RejectRevisionRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.revisions.reject(revisionId, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
