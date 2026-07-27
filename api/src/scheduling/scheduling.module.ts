import { Module } from '@nestjs/common';
import { AssetScheduleController } from './asset-schedule.controller';
import { AssetScheduleService } from './asset-schedule.service';
import { CompletionCascadeService } from './completion-cascade.service';
import { JobGenerationService } from './job-generation.service';
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
  controllers: [AssetScheduleController],
  providers: [
    AssetScheduleService,
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
