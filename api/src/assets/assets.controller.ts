import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  assetCreateSchema,
  assetUpdateSchema,
  type AssetCreate,
  type AssetUpdate,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AssetsService } from './assets.service';

/** PR-020 `asset` — matches `api/openapi.yaml` `/assets*` paths exactly. */
@Controller('assets')
@UseGuards(RolesGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('assetTypeId') assetTypeId?: string,
    @Query('areaId') areaId?: string,
    @Query('status') status?: string,
  ) {
    return this.assets.list(user.sub, { limit, cursor, assetTypeId, areaId, status });
  }

  @Get(':assetId')
  get(@Param('assetId') assetId: string, @CurrentUser() user: AccessTokenClaims) {
    return this.assets.get(user.sub, assetId);
  }

  @Get(':assetId/history')
  history(
    @Param('assetId') assetId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.assets.history(user.sub, assetId, { limit, cursor });
  }

  @Post()
  @Roles('ENGINEER', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(assetCreateSchema)) dto: AssetCreate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.assets.create(dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Patch(':assetId')
  @Roles('ENGINEER', 'ADMIN')
  update(
    @Param('assetId') assetId: string,
    @Body(new ZodValidationPipe(assetUpdateSchema)) dto: AssetUpdate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.assets.update(user.sub, assetId, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
