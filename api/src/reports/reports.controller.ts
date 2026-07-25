import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { measurementTrendQuerySchema, type MeasurementTrendQuery } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JOB_VIEW_ALL_ROLES } from '../jobs/job-access';
import { ReportsService } from './reports.service';

/**
 * PRD §9 report surface — `/reports/compliance|overdue|pending|measurements`.
 * Read-only. `@Roles(...JOB_VIEW_ALL_ROLES)` — the same broad-visibility set
 * `job-access.ts` already establishes for "see everything in area scope"
 * (TEAM_LEADER/ENGINEER/DOC_CONTROLLER/ADMIN/AUDITOR); these are
 * organisation-wide reports, not a per-user work list, so MAINTAINER
 * (own-jobs-only elsewhere) does not get a route here — mirrors
 * API_SPECIFICATION.md §4.1's "Export records" row, which draws the exact
 * same line.
 */
@Controller('reports')
@UseGuards(RolesGuard)
@Roles(...JOB_VIEW_ALL_ROLES)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('measurements')
  getMeasurementTrend(
    @Query(new ZodValidationPipe(measurementTrendQuerySchema))
    query: MeasurementTrendQuery,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.reports.measurementTrend(user.sub, query);
  }

  @Get('overdue')
  getOverdue(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reports.overdue(user.sub, user.roles, limit, cursor);
  }

  @Get('pending')
  getPending(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reports.pending(user.sub, user.roles, limit, cursor);
  }

  @Get('compliance')
  getCompliance(
    @CurrentUser() user: AccessTokenClaims,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('areaId') areaId?: string,
  ) {
    return this.reports.compliance(user.sub, { from, to, areaId });
  }
}
