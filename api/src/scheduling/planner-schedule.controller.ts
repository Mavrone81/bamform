import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { plannerScheduleQuerySchema, type PlannerScheduleQuery } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PlannerScheduleService } from './planner-schedule.service';

/**
 * `api/openapi.yaml` `/schedule` — slice 31-PLANNER. The CROSS-MACHINE
 * schedule read: every rule in the plant across a date window, which is the
 * question `GET /assets/{assetId}/schedule` cannot answer and the spreadsheet
 * `ML-S-MFT-00015` exists to answer.
 *
 * Handler named `listSchedule`, deliberately: this IS a tenant-wide,
 * paginated collection read, so it must be discovered and classified by
 * `test:scope-coverage`'s `list*` convention
 * (`api/test/contract/known-gaps.ts#COLLECTION_ENDPOINTS`) — the exact
 * opposite of `AssetScheduleController#getSchedule`, whose own header
 * explains why the fixed-cardinality one-asset read is NOT named `list*`.
 */
@Controller('schedule')
@UseGuards(RolesGuard)
export class PlannerScheduleController {
  constructor(private readonly service: PlannerScheduleService) {}

  /**
   * Deliberately carries NO `@Roles()`, matching its sibling
   * `GET /assets/{assetId}/schedule` exactly.
   *
   * This was the one place a deviation was seriously considered, because the
   * SCREEN this feeds (`/planner`) is offered only to the roles that plan
   * (`rolesCanAdjustSchedule`: PLANNER, TEAM_LEADER, ENGINEER, ADMIN). It is
   * not the same question. Annotating this handler would REFUSE the read to
   * MAINTAINER, DOC_CONTROLLER and AUDITOR — three roles that can already
   * read every one of these rows today, one machine at a time, through
   * `GET /assets/{id}/schedule`. Slice 18-WORKFLOW's governing rule is "ADD,
   * never remove", and gating an aggregate of data the caller may already
   * read row by row buys no confidentiality: it only makes an AUDITOR fetch
   * 76 URLs to see what one would show them. The area scope, which is the
   * real confidentiality boundary here, is enforced in the repository and
   * applies identically either way.
   *
   * The WRITE side is unchanged and unaffected: adjusting a date still goes
   * through `PUT /assets/{assetId}/schedule`, still
   * `@Roles('PLANNER','TEAM_LEADER','ENGINEER','ADMIN')`. The planner grid
   * reads here and writes there.
   */
  @Get()
  listSchedule(
    @Query(new ZodValidationPipe(plannerScheduleQuerySchema)) query: PlannerScheduleQuery,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.service.list(user.sub, query);
  }
}
