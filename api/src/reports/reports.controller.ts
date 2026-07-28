import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { measurementTrendQuerySchema, type MeasurementTrendQuery } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ORG_REPORTING_ROLES } from '../jobs/job-access';
import { ReportsService } from './reports.service';

/**
 * PRD §9 report surface — `/reports/compliance|overdue|pending|measurements`.
 * Read-only, organisation-wide aggregates rather than a per-user work list,
 * so MAINTAINER (own-jobs-only elsewhere) does not get a route here — the
 * same line API_SPECIFICATION.md §4.1's "Export records" row draws.
 *
 * Slice 18-WORKFLOW review, finding X-1 (Critical): this was
 * `@Roles(...JOB_VIEW_ALL_ROLES)`, which meant adding PLANNER to that ACCESS
 * PREDICATE silently handed a planning role the whole reports surface
 * (measured: `GET /reports/compliance` 200 for PLANNER, 403 for MAINTAINER),
 * contradicting the permission matrix slice 18 itself rewrote. It now uses
 * `ORG_REPORTING_ROLES` — a list whose only job is annotating these bulk
 * surfaces, so it cannot be widened as a side effect. See `job-access.ts`.
 */
@Controller('reports')
@UseGuards(RolesGuard)
@Roles(...ORG_REPORTING_ROLES)
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
