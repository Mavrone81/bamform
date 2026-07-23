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
  assetTypeCreateSchema,
  assetTypeUpdateSchema,
  type AssetTypeCreate,
  type AssetTypeUpdate,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AssetTypesService } from './asset-types.service';

/**
 * PR-019 `asset_type`. Not present in `api/openapi.yaml` (gap flagged in
 * slice-4-report.md) — shape follows API_SPECIFICATION.md §10.3. Create/edit
 * gated to ENGINEER/ADMIN, mirroring the permission matrix's "Create/edit
 * assets" row (§4.1) — asset types are asset-adjacent reference data with no
 * dedicated matrix row of their own.
 */
@Controller('asset-types')
@UseGuards(RolesGuard)
export class AssetTypesController {
  constructor(private readonly assetTypes: AssetTypesService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.assetTypes.list({ limit, cursor });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.assetTypes.get(id);
  }

  @Post()
  @Roles('ENGINEER', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(assetTypeCreateSchema)) dto: AssetTypeCreate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.assetTypes.create(dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Patch(':id')
  @Roles('ENGINEER', 'ADMIN')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assetTypeUpdateSchema)) dto: AssetTypeUpdate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.assetTypes.update(id, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
