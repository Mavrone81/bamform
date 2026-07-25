import { Inject, Injectable } from '@nestjs/common';
import type { Queue, QueueEvents } from 'bullmq';
import { PDF_QUEUE, PDF_QUEUE_EVENTS } from './pdf.tokens';
import type {
  PdfExportJobPayload,
  PdfExportJobResult,
  PdfRenderJobPayload,
  PdfRenderJobResult,
} from './pdf-payloads';

/** How long `api` waits for the worker's Chromium render before giving up (P-08: render should be well under 5s; generous margin for a cold worker/queue backlog). */
const RENDER_TIMEOUT_MS = 30_000;
/** Export jobs render many PDFs — much longer budget (P-09: bulk export of 100 records). */
const EXPORT_TIMEOUT_MS = 10 * 60_000;

const REMOVE_ON_FAIL_COUNT = 200;

/**
 * Producer side of the `bamform-pdf` queue (`pdf.tokens.ts`) — the ONLY
 * class `api` imports from this module, mirroring
 * `NotificationQueueService`'s producer/consumer split. Unlike
 * notifications (fire-and-forget), `api` DOES wait for these jobs
 * (`Job#waitUntilFinished`) because both `GET /records/{recordId}/pdf` and
 * the export poll need the worker's result to respond to an HTTP caller.
 */
@Injectable()
export class PdfQueueService {
  constructor(
    @Inject(PDF_QUEUE) private readonly queue: Queue,
    @Inject(PDF_QUEUE_EVENTS) private readonly queueEvents: QueueEvents,
  ) {}

  async renderRecordPdf(payload: PdfRenderJobPayload): Promise<PdfRenderJobResult> {
    const job = await this.queue.add('render', payload, {
      removeOnComplete: true,
      removeOnFail: REMOVE_ON_FAIL_COUNT,
    });
    const result = await job.waitUntilFinished(this.queueEvents, RENDER_TIMEOUT_MS);
    return result as PdfRenderJobResult;
  }

  async enqueueExport(payload: PdfExportJobPayload): Promise<void> {
    await this.queue.add('export', payload, {
      removeOnComplete: true,
      removeOnFail: REMOVE_ON_FAIL_COUNT,
    });
  }

  /** Exposed for tests — the export flow polls `record_export` in Postgres, not this job's BullMQ state, but a test may want to await completion directly. */
  async waitForExportJob(payload: PdfExportJobPayload): Promise<PdfExportJobResult> {
    const jobs = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    const job = jobs.find(
      (j) => j.name === 'export' && (j.data as PdfExportJobPayload).exportId === payload.exportId,
    );
    if (!job) {
      throw new Error(`No pending export job found for exportId ${payload.exportId}`);
    }
    const result = await job.waitUntilFinished(this.queueEvents, EXPORT_TIMEOUT_MS);
    return result as PdfExportJobResult;
  }
}
