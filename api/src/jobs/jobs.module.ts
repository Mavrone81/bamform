import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ApprovalController } from './approval.controller';
import { ApprovalRepository } from './approval.repository';
import { ApprovalTransitionsService } from './approval-transitions.service';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { IntegrityService } from './integrity.service';
import { JobAccessService } from './job-access';
import { JobsController } from './jobs.controller';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { PartsService } from './parts.service';
import { RecordsController } from './records.controller';
import { ResultsService } from './results.service';
import { SubmissionService } from './submission.service';
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
 */
@Module({
  imports: [QueueModule],
  controllers: [JobsController, AttachmentsController, ApprovalController, RecordsController],
  providers: [
    JobAccessService,
    JobsRepository,
    JobsService,
    ResultsService,
    PartsService,
    SubmissionService,
    AttachmentsService,
    ApprovalRepository,
    VerificationService,
    ApprovalTransitionsService,
    IntegrityService,
  ],
})
export class JobsModule {}
