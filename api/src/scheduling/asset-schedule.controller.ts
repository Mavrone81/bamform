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

  @Get()
  getSchedule(@Param('assetId') assetId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.service.list(user.sub, assetId);
  }

  @Put()
  @Roles('TEAM_LEADER', 'ENGINEER', 'ADMIN')
  adjustSchedule(
    @Param('assetId') assetId: string,
    @Body(new ZodValidationPipe(scheduleAdjustRequestSchema)) dto: ScheduleAdjustRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.service.adjust(user.sub, assetId, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
