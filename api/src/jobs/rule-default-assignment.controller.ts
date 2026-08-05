import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  applyDefaultAssigneeRequestSchema,
  type ApplyDefaultAssigneeRequest,
} from '@bamform/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/jwt/access-token.types';
import { requestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RuleDefaultAssignmentService } from './rule-default-assignment.service';

/**
 * `api/openapi.yaml`
 * `/schedule/{scheduleRuleId}/default-assignee/apply-to-existing` — slice
 * 33-APPLYDEFAULT.
 *
 * A `/schedule` PATH SERVED FROM `JobsModule`, which is unusual enough to say
 * why. The URL belongs on the schedule surface: the thing being applied is
 * `schedule_rule.default_assignee_id`, the scope is one rule, and the planner
 * grid already holds the rule id on every row. The IMPLEMENTATION has to live
 * here, because applying it means calling `AssignmentService` — the same
 * service `POST /jobs/{jobId}/assign` calls — and `JobsModule` imports
 * `SchedulingModule` rather than the other way round (slice 15-SYSWIRE), so
 * the scheduling side cannot reach it. Nest routes by decorator, not by
 * module, so the honest URL and the acyclic graph are both available; the
 * alternative was a second implementation of the assignment transition, which
 * would have been an assignment with no audit event and no notification.
 *
 * It cannot collide with `PlannerScheduleController`: that one declares
 * `PUT :scheduleRuleId/default-assignee`, this one
 * `POST :scheduleRuleId/default-assignee/apply-to-existing` — different path,
 * different method.
 *
 * Handler deliberately NOT named `list*`: `test:scope-coverage` classifies by
 * that convention, and this is a write.
 */
@Controller('schedule')
@UseGuards(RolesGuard)
export class RuleDefaultAssignmentController {
  constructor(private readonly service: RuleDefaultAssignmentService) {}

  /**
   * `@Roles('PLANNER','TEAM_LEADER','ENGINEER','ADMIN')` — EXACTLY the set on
   * `POST /jobs/{jobId}/assign` and on `PUT .../default-assignee`, because
   * this is neither more nor less than doing the first of those, several
   * times, to the jobs the second one named. Declared in full rather than
   * shared with them, matching the convention `route-roles.ts` documents: a
   * future narrowing of one route must not silently narrow another.
   */
  @Post(':scheduleRuleId/default-assignee/apply-to-existing')
  // 200, not Nest's default 201: this creates nothing. It applies a decision
  // to jobs that already exist, and a partial application — some assigned,
  // some refused — is a perfectly ordinary 200 body, not an error.
  @HttpCode(HttpStatus.OK)
  @Roles('PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN')
  applyDefaultAssigneeToExistingJobs(
    @Param('scheduleRuleId') scheduleRuleId: string,
    @Body(new ZodValidationPipe(applyDefaultAssigneeRequestSchema))
    dto: ApplyDefaultAssigneeRequest,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ) {
    return this.service.applyToExistingJobs(
      { actorId: user.sub, ...requestMeta(req) },
      // The roles reach `JobsService#loadForMutation` unchanged, so each job
      // in the batch is visibility-checked exactly as a single assign is.
      user.roles,
      scheduleRuleId,
      dto,
    );
  }
}
