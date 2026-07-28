import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { scheduleAdjustRequestSchema, type ScheduleAdjustRequest } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AssetScheduleService } from './asset-schedule.service';

/**
 * `api/openapi.yaml` `/assets/{assetId}/schedule` — PR-058/UR-023/UR-025.
 * Handler named `getSchedule`, not `list*`, deliberately: this returns a
 * small, fixed-cardinality set (one row per frequency) scoped to ONE
 * already-in-scope-checked asset, not a tenant-wide collection —
 * `test:scope-coverage`'s `list*` convention (api/test/contract/known-gaps.ts)
 * is about paginated collection reads, which this is not.
 */
@Controller('assets/:assetId/schedule')
@UseGuards(RolesGuard)
export class AssetScheduleController {
  constructor(private readonly service: AssetScheduleService) {}

  /**
   * Deliberately carries NO `@Roles()`: reading an asset's schedule is open
   * to every authenticated user (area-scoped inside the service), and it has
   * been since slice 5. Slice 18-WORKFLOW's brief asks for PLANNER to be
   * added to "schedule GET/PUT" — on GET that would be a REMOVAL, not an
   * addition (an unannotated handler admits everyone; `@Roles('PLANNER',...)`
   * would start refusing MAINTAINER and AUDITOR). The brief's own governing
   * rule is "ADD, never remove", so GET is left exactly as it is: PLANNER can
   * already read it, along with everyone else. See the report's role matrix.
   */
  @Get()
  getSchedule(@Param('assetId') assetId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.service.list(user.sub, assetId);
  }

  /**
   * UR-023/UR-025 — the manual next-due-date adjustment. Slice 18-WORKFLOW
   * adds PLANNER: planning the PM schedule is what the role exists for.
   * ADDITIVE — TEAM_LEADER/ENGINEER/ADMIN keep exactly the right they had.
   */
  @Put()
  @Roles('PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN')
  adjustSchedule(
    @Param('assetId') assetId: string,
    @Body(new ZodValidationPipe(scheduleAdjustRequestSchema)) dto: ScheduleAdjustRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.service.adjust(user.sub, assetId, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
