import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  plannerScheduleQuerySchema,
  setDefaultAssigneeRequestSchema,
  type PlannerScheduleQuery,
  type SetDefaultAssigneeRequest,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
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

  /**
   * Slice 32-PLANNERJOB — WHO this machine's PM may be given to.
   *
   * Serves BOTH assignment levels from one list, because they are judged
   * against the same machine's area and therefore cannot legitimately differ:
   * the standing assignee on the rule, and the assignee on the job generated
   * from it. Keyed by the RULE rather than the job, because the rule exists
   * before the job does and a visit still awaiting generation needs a picker
   * too.
   *
   * `@Roles()` matches `PUT .../default-assignee` below and
   * `POST /jobs/{jobId}/assign` exactly: the right to see the candidates and
   * the right to choose one are the same right. This is the one place in the
   * schedule surface that IS role-gated — `GET /schedule` is open to every
   * authenticated caller because a schedule is not confidential, whereas a
   * list of the plant's technicians, however narrow, is not something an
   * AUDITOR or DOC_CONTROLLER has any reason to receive.
   *
   * Named `list*` so `test:scope-coverage` discovers and classifies it
   * (`known-gaps.ts#COLLECTION_ENDPOINTS`) instead of letting a new
   * collection read past unclassified.
   */
  @Get(':scheduleRuleId/assignable-users')
  @Roles('PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN')
  listAssignableUsers(
    @Param('scheduleRuleId') scheduleRuleId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listAssignableUsers(user.sub, scheduleRuleId, { limit, cursor });
  }

  /**
   * Slice 32-PLANNERJOB — set (or clear) WHO NORMALLY DOES THIS PM.
   *
   * `@Roles('PLANNER','TEAM_LEADER','ENGINEER','ADMIN')`, the same set as
   * `PUT /assets/{assetId}/schedule` and `POST /jobs/{jobId}/assign`: deciding
   * when work happens and deciding who does it are the same planning job.
   * Declared here in full rather than shared with those routes' lists —
   * `route-roles.spec.ts` pins every route's set independently so a future
   * narrowing of one cannot silently narrow the others.
   *
   * A rule-keyed WRITE on a schedule surface whose sibling write is
   * asset-keyed (`PUT /assets/{assetId}/schedule`), and deliberately so: that
   * one is asset-keyed to keep every pre-slice-27 caller working, a
   * compatibility debt a NEW endpoint has no reason to inherit. A rule id is
   * exactly what identifies the thing being changed, and the planner grid
   * already carries it on every row.
   */
  @Put(':scheduleRuleId/default-assignee')
  @Roles('PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN')
  setDefaultAssignee(
    @Param('scheduleRuleId') scheduleRuleId: string,
    @Body(new ZodValidationPipe(setDefaultAssigneeRequestSchema)) dto: SetDefaultAssigneeRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.service.setDefaultAssignee(
      { actorId: user.sub, ...requestMeta(req) },
      scheduleRuleId,
      dto,
    );
  }
}
