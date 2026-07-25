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
  userCreateSchema,
  userUpdateSchema,
  type UserCreate,
  type UserUpdate,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

/**
 * PR-037/UR-072 `app_user` administration (API_SPECIFICATION.md §10.9:
 * "GET POST /users — ADMIN only", "GET PATCH /users/{id} — Deactivation
 * only, never deletion (UR-075)"). ADMIN-only on the whole controller,
 * server-enforced (UR-074) — never a client-side-only check.
 */
@Controller('users')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('roleCode') roleCode?: string,
    @Query('active') active?: string,
  ) {
    return this.users.list({ limit, cursor, roleCode, active });
  }

  @Get(':userId')
  get(@Param('userId') userId: string) {
    return this.users.get(userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(userCreateSchema)) dto: UserCreate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.users.create(dto, { actorId: user.sub, ...requestMeta(req) });
  }

  @Patch(':userId')
  update(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(userUpdateSchema)) dto: UserUpdate,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.users.update(userId, dto, { actorId: user.sub, ...requestMeta(req) });
  }
}
