import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  userAreaScopeSetSchema,
  userCreateSchema,
  userUpdateSchema,
  type UserAreaScopeSet,
  type UserCreate,
  type UserUpdate,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { MfaService } from '../auth/mfa/mfa.service';
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
  constructor(
    private readonly users: UsersService,
    private readonly mfa: MfaService,
  ) {}

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

  /**
   * Slice 13-MFA §5 (D-3) — the ADMIN escape hatch when a user loses both
   * their authenticator and their recovery codes. Clears the enrolment and
   * invalidates every unused recovery code, forcing a fresh enrolment.
   *
   * An admin can RESET but can never READ: there is no endpoint that returns
   * anyone's TOTP secret or recovery codes, and this one only writes.
   * Audited with both actor and subject (`mfa_reset`).
   */
  @Post(':userId/mfa-reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetMfa(
    @Param('userId') userId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ): Promise<void> {
    await this.mfa.resetForUser(userId, { actorId: user.sub, ...requestMeta(req) });
  }

  /**
   * Slice 13-UI-B (SYS-10) — sets/REPLACES the user's area-scope set
   * (PR-API-10's write path; `API_SPECIFICATION.md` §10.9's user-roles
   * conventions applied to `user_area_scope`). `[]` clears every scope
   * (unrestricted). Soft-remove semantics, `permission_change` audit —
   * see `UsersService#setAreaScopes`.
   */
  @Put(':userId/area-scopes')
  setAreaScopes(
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(userAreaScopeSetSchema)) dto: UserAreaScopeSet,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.users.setAreaScopes(userId, dto, { actorId: user.sub, ...requestMeta(req) });
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
