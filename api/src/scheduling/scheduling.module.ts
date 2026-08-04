import { Module } from '@nestjs/common';
import { AssignableUserModule } from '../jobs/assignable-user.module';
import { AssetScheduleController } from './asset-schedule.controller';
import { AssetScheduleService } from './asset-schedule.service';
import { CompletionCascadeService } from './completion-cascade.service';
import { JobGenerationService } from './job-generation.service';
import { PlannerScheduleController } from './planner-schedule.controller';
import { PlannerScheduleRepository } from './planner-schedule.repository';
import { PlannerScheduleService } from './planner-schedule.service';
import { ScheduleRuleBootstrapService } from './schedule-rule-bootstrap.service';
import { SchedulerLockService } from './scheduler-lock.service';
import { SchedulerService } from './scheduler.service';
import { VoidScheduleRecomputeService } from './void-schedule-recompute.service';

/**
 * Slice 5 — scheduling engine (PR-050..058). Imported by BOTH `AppModule`
 * (for the HTTP `/assets/{id}/schedule` endpoint) and `WorkerModule`
 * (`worker.ts`, for `SchedulerService` — the worker never serves HTTP, so
 * `AssetScheduleController` being part of the same module graph there is
 * harmless: `NestFactory.createApplicationContext` never wires a router).
 *
 * `AreaScopeService`/`AuditEventService` come from the global
 * `CommonModule`/`AuditModule` (see `app.module.ts`) — not re-declared here.
 */
@Module({
  // `AssignableUserModule`: slice 32-PLANNERJOB. A `schedule_rule` can now
  // carry a STANDING assignee, which the planner sets and
  // `JobGenerationService` applies at generation time — both against the same
  // rule `POST /jobs/{jobId}/assign` enforces. It is its own module precisely
  // so this can reach it: `JobsModule` imports THIS module (slice 15-SYSWIRE),
  // so importing `JobsModule` back would be a cycle.
  imports: [AssignableUserModule],
  controllers: [AssetScheduleController, PlannerScheduleController],
  providers: [
    AssetScheduleService,
    // Slice 31-PLANNER — the cross-machine read (`GET /schedule`). Lives
    // here rather than in a module of its own because it is the same
    // `schedule_rule` aggregate `AssetScheduleService` serves per machine,
    // and the worker (which imports this module for `SchedulerService`)
    // wires no router, so the extra controller costs it nothing.
    PlannerScheduleRepository,
    PlannerScheduleService,
    ScheduleRuleBootstrapService,
    JobGenerationService,
    SchedulerLockService,
    SchedulerService,
    CompletionCascadeService,
    VoidScheduleRecomputeService,
  ],
  exports: [
    SchedulerService,
    ScheduleRuleBootstrapService,
    JobGenerationService,
    CompletionCascadeService,
    VoidScheduleRecomputeService,
  ],
})
export class SchedulingModule {}
