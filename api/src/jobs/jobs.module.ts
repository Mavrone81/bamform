import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AdhocJobService } from './adhoc-job.service';
import { AssignableUserModule } from './assignable-user.module';
import { ApprovalController } from './approval.controller';
import { ApprovalRepository } from './approval.repository';
import { ApprovalTransitionsService } from './approval-transitions.service';
import { AssignmentService } from './assignment.service';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { IntegrityService } from './integrity.service';
import { JobAccessService } from './job-access';
import { JobsController } from './jobs.controller';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { PartsService } from './parts.service';
import { ResultsService } from './results.service';
import { RuleDefaultAssignmentController } from './rule-default-assignment.controller';
import { RuleDefaultAssignmentService } from './rule-default-assignment.service';
import { StageEscalationService } from './stage-escalation.service';
import { SubmissionService } from './submission.service';
import { TitleMachineNumberService } from './title-machine-number.service';
import { VerificationService } from './verification.service';

/**
 * Slices 6-7 — jobs, results, parts, attachments, submission gate
 * (PR-030..034/045/011/012), approval workflow (PR-041..046/070..077/093/
 * 094, slice 7). `AreaScopeService`/`AuditEventService`/`IdempotencyService`
 * come from the global `CommonModule`/`AuditModule` (slices 1-5);
 * `MinioService` from the global `MinioModule`; `FIELD_ENCRYPTION_SERVICE`/
 * `RECORD_SIGNING_SERVICE` from the global `CryptoModule` (slice 3) — none
 * are re-declared here. `NotificationQueueService` similarly comes from the
 * global `NotificationQueueModule` (slice 11a). `QueueModule` IS imported
 * explicitly (not global) for `VerifierEligibilityService` — PR-077/UR-063's
 * "notify whoever is eligible to verify this stage right now", reused by
 * `SubmissionService` rather than re-deriving the eligibility rule.
 *
 * Slice 12 moves `RecordsController` OUT of this module (into
 * `records/records.module.ts`) — it now also needs `PdfCoordinatorService`
 * (`pdf/pdf.module.ts`), which itself needs `JobsRepository`/`JobAccessService`
 * FROM here, so keeping the controller here would create a module import
 * cycle. `IntegrityService` is now exported so `RecordsController` (declared
 * in the new module) can still inject it — same provider, no behaviour change.
 */
@Module({
  // SchedulingModule: slice 15-SYSWIRE (SYS-1) — `VerificationService`'s
  // final-stage transaction calls `CompletionCascadeService.apply` (the seam
  // slice 5 built for exactly this). No cycle: SchedulingModule imports no
  // job-side module.
  // `AssignableUserModule`: slice 32-PLANNERJOB — the "who may be given this
  // work" rule, shared with `SchedulingModule` (which sets a schedule's
  // standing assignee and honours it at generation time) and therefore
  // declared outside both. See that module's own note for why it cannot live
  // here.
  imports: [QueueModule, SchedulingModule, AssignableUserModule],
  // `RuleDefaultAssignmentController` serves a `/schedule` path from this
  // module — slice 33-APPLYDEFAULT. Its own header says why: the URL belongs
  // to the schedule surface, but applying a standing assignee to the jobs a
  // plan has already raised means calling `AssignmentService` below, and
  // `SchedulingModule` cannot import this module back (see `imports`).
  controllers: [
    JobsController,
    AttachmentsController,
    ApprovalController,
    RuleDefaultAssignmentController,
  ],
  providers: [
    JobAccessService,
    JobsRepository,
    JobsService,
    ResultsService,
    PartsService,
    TitleMachineNumberService,
    SubmissionService,
    AssignmentService,
    RuleDefaultAssignmentService,
    AdhocJobService,
    StageEscalationService,
    AttachmentsService,
    ApprovalRepository,
    VerificationService,
    ApprovalTransitionsService,
    IntegrityService,
  ],
  // Slice 9 (`sync.module.ts`) reuses these directly rather than
  // reimplementing job assembly/result/part capture: `JobsRepository`
  // (batched frozen-revision read for bootstrap), `JobAccessService`
  // (area+assignee scope), `ResultsService`/`PartsService` (the outbox
  // drain dispatches straight into their existing idempotency-backed,
  // per-mutation-transactional methods — see `sync-outbox.service.ts`).
  // Slice 12's `records/records.module.ts` additionally reuses
  // `JobsRepository`/`JobAccessService`/`IntegrityService`.
  // `TitleMachineNumberService` joins the exported set for the same reason
  // `ResultsService`/`PartsService` are there: slice 31-TITLEBLANK's capture
  // PUT is outbox-reachable, and `sync-outbox.service.ts` dispatches into
  // this exact method rather than reimplementing it.
  exports: [
    JobsRepository,
    JobAccessService,
    ResultsService,
    PartsService,
    TitleMachineNumberService,
    IntegrityService,
  ],
})
export class JobsModule {}
