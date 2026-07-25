import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { JobAccessService } from './job-access';
import { JobsController } from './jobs.controller';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { PartsService } from './parts.service';
import { ResultsService } from './results.service';
import { SubmissionService } from './submission.service';

/**
 * Slice 6 — jobs, results, parts, attachments, submission gate
 * (PR-030..034/045/011/012). `AreaScopeService`/`AuditEventService`/
 * `IdempotencyService` come from the global `CommonModule`/`AuditModule`
 * (slices 1-5); `MinioService` from the global `MinioModule` — none are
 * re-declared here.
 */
@Module({
  controllers: [JobsController, AttachmentsController],
  providers: [
    JobAccessService,
    JobsRepository,
    JobsService,
    ResultsService,
    PartsService,
    SubmissionService,
    AttachmentsService,
  ],
})
export class JobsModule {}
