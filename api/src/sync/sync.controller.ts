import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { outboxRequestSchema, type OutboxRequest } from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JOB_RECORD_ROLES } from '../jobs/job-access';
import { SyncBootstrapService } from './sync-bootstrap.service';
import { SyncOutboxService } from './sync-outbox.service';

/**
 * PR-API-22..27 — matches `api/openapi.yaml`'s `/sync/bootstrap`/`/sync/outbox`
 * paths exactly.
 */
@Controller('sync')
@UseGuards(RolesGuard)
export class SyncController {
  constructor(
    private readonly bootstrapService: SyncBootstrapService,
    private readonly outboxService: SyncOutboxService,
  ) {}

  /**
   * No `@Roles()` — mirrors `JobsController#list`/`#get` (`GET /jobs`,
   * `GET /jobs/{id}`): visibility is entirely governed by
   * `JobAccessService`'s area+assignee scoping (view own vs. view-all-in-
   * scope roles), not a fixed role allowlist — `AUDITOR`/`DOC_CONTROLLER`
   * can legitimately bootstrap too (API_SPECIFICATION.md §4.1 "View all
   * jobs in scope").
   */
  @Get('bootstrap')
  bootstrap(@CurrentUser() user: AccessTokenClaims, @Query('since') since?: string) {
    return this.bootstrapService.bootstrap(user.sub, user.roles, since);
  }

  /**
   * `@Roles(...JOB_RECORD_ROLES)` here is NOT redundant with the dispatched
   * services' own checks: `ResultsService`/`PartsService` only enforce
   * area+assignee access (`JobAccessService#assertAccessible`), not the
   * "Record results" role gate — that gate lives on `jobs.controller.ts`'s
   * `@Put`/`@Post` handlers via this SAME decorator. The outbox bypasses
   * those controllers entirely (dispatches straight to the services), so
   * this endpoint must re-apply the gate itself or a DOC_CONTROLLER/AUDITOR
   * could mutate results through the batch that they cannot through the
   * direct endpoint.
   */
  @Post('outbox')
  @Roles(...JOB_RECORD_ROLES)
  @HttpCode(HttpStatus.OK)
  drainOutbox(
    @Body(new ZodValidationPipe(outboxRequestSchema)) dto: OutboxRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.outboxService.drain(
      dto.mutations,
      { actorId: user.sub, ...requestMeta(req) },
      user.roles,
    );
  }
}
