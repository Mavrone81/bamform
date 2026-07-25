import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { recordExportRequestSchema, type RecordExportRequest } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JOB_VIEW_ALL_ROLES } from '../jobs/job-access';
import { RecordsExportService } from './records-export.service';

/**
 * PR-119, UR-059 — API_SPECIFICATION.md §4.1 "Export records" row grants
 * `JOB_VIEW_ALL_ROLES` only (TEAM_LEADER/ENGINEER/DOC_CONTROLLER/ADMIN/
 * AUDITOR) — NOT MAINTAINER, unlike "View archive" (which additionally
 * grants MAINTAINER their own records). `@Roles()` enforces that
 * distinction at the route.
 */
@Controller()
@UseGuards(RolesGuard)
export class ExportsController {
  constructor(private readonly exports: RecordsExportService) {}

  @Post('records/export')
  @Roles(...JOB_VIEW_ALL_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  requestExport(
    @Body(new ZodValidationPipe(recordExportRequestSchema)) dto: RecordExportRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.exports.requestExport({ actorId: user.sub, ...requestMeta(req) }, user.roles, dto);
  }

  @Get('exports/:exportId')
  @Roles(...JOB_VIEW_ALL_ROLES)
  getStatus(@Param('exportId') exportId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.exports.getStatus(exportId, { actorId: user.sub });
  }

  /** ADR-007 — streamed through `api`, authorised on every fetch, never a presigned URL. */
  @Get('exports/:exportId/download')
  @Roles(...JOB_VIEW_ALL_ROLES)
  download(@Param('exportId') exportId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.exports.download(exportId, { actorId: user.sub });
  }
}
