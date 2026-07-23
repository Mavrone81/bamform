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
  areaCreateSchema,
  areaUpdateSchema,
  type AreaCreate,
  type AreaUpdate,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { requestMeta } from '../common/request-meta';
import { AreasService } from './areas.service';

/**
 * DBD §6.1 `area` — PR-API-10's scope source, not itself area-scoped (an
 * area cannot be scoped to itself). Not present in `api/openapi.yaml` at all
 * (slice-4-report.md flags this) — shape follows API_SPECIFICATION.md §10.3
 * and the same conventions `assets.controller.ts` uses for the paths that
 * ARE in openapi.yaml.
 */
@Controller('areas')
@UseGuards(RolesGuard)
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.areas.list({ limit, cursor });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.areas.get(id);
  }

  @Post()
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(areaCreateSchema)) dto: AreaCreate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.areas.create(dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(areaUpdateSchema)) dto: AreaUpdate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.areas.update(id, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
