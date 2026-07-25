import { Injectable } from '@nestjs/common';
import { notFoundProblem, pdfNotYetAvailableProblem } from '../common/domain-problems';
import { JobAccessService } from '../jobs/job-access';
import { latestApprovalStep } from '../jobs/job-include';
import { JobsRepository } from '../jobs/jobs.repository';
import { PdfQueueService } from './pdf-queue.service';

export interface PdfActor {
  userId: string;
  roles: string[];
}

/**
 * `api`-side of `GET /records/{recordId}/pdf` — PR-117: this class never
 * touches Chromium. It validates (existence, area/role access reused from
 * `JobAccessService` — the SAME rule live-job reads use, since "any record
 * the caller may view" is the correct PDF-access rule per UR-056/PR-116;
 * archival status is not itself the access gate) and the PR-118
 * precondition (at least one `approval_step` must exist — otherwise there
 * is no digest to print, `pdfNotYetAvailableProblem`) BEFORE enqueuing,
 * synchronously, on `api`, so a caller gets the right RFC 9457 problem
 * immediately rather than racing a BullMQ job failure message. Only once
 * those pass does it hand off to the worker (`PdfQueueService`) and await
 * the rendered bytes.
 */
@Injectable()
export class PdfCoordinatorService {
  constructor(
    private readonly jobsRepo: JobsRepository,
    private readonly access: JobAccessService,
    private readonly pdfQueue: PdfQueueService,
  ) {}

  async getRecordPdf(recordId: string, actor: PdfActor): Promise<Buffer> {
    const job = await this.jobsRepo.findById(recordId);
    if (!job) {
      throw notFoundProblem('Record', recordId);
    }
    await this.access.assertAccessible(
      { userId: actor.userId, roles: actor.roles },
      { assignedTo: job.assignedTo, areaId: job.asset.areaId },
    );
    if (latestApprovalStep(job) === null) {
      throw pdfNotYetAvailableProblem(recordId);
    }

    const result = await this.pdfQueue.renderRecordPdf({ recordId });
    return Buffer.from(result.pdfBase64, 'base64');
  }
}
