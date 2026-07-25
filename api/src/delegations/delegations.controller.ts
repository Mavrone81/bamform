import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { createDelegationRequestSchema, type CreateDelegationRequest } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DELEGATION_MANAGE_ROLES, DelegationsService } from './delegations.service';

/**
 * PR-038/PR-076/UR-052 — `GET/POST /delegations`, `DELETE /delegations/{id}`
 * (API_SPECIFICATION.md §3). `GET` has no `@Roles()` — every authenticated
 * user may see their OWN delegations (as delegator or delegate); the
 * "Create delegation" permission-matrix row (§4.1) only gates the mutations.
 */
@Controller('delegations')
@UseGuards(RolesGuard)
export class DelegationsController {
  constructor(private readonly delegations: DelegationsService) {}

  @Get()
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.delegations.list(user.sub, { limit, cursor });
  }

  @Post()
  @Roles(...DELEGATION_MANAGE_ROLES)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createDelegationRequestSchema)) dto: CreateDelegationRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.delegations.create({ actorId: user.sub, ...requestMeta(req) }, user.roles, dto);
  }

  /** Soft-revoke (sets `revokedAt`) — never a hard delete of the row. */
  @Delete(':delegationId')
  @Roles(...DELEGATION_MANAGE_ROLES)
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('delegationId') delegationId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.delegations.revoke(
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
      delegationId,
    );
  }
}
