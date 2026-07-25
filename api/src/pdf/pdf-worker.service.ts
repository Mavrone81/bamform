import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { RecordsExportWorkerService } from '../exports/records-export-worker.service';
import { buildBullConnection, bullQueuePrefix } from '../notifications/bullmq-connection';
import { PDF_QUEUE_NAME } from './pdf.tokens';
import type { PdfExportJobPayload, PdfRenderJobPayload } from './pdf-payloads';
import { PdfRenderService } from './pdf-render.service';

/**
 * The BullMQ CONSUMER for `bamform-pdf` (PR-116/117/119) — mirrors
 * `NotificationWorkerService`'s shape exactly. `concurrency` here bounds how
 * many QUEUE JOBS run at once (a generous number — an `export` job is
 * long-running and would otherwise starve concurrent `render` requests);
 * the ACTUAL Chromium concurrency cap is `RenderSemaphore` inside
 * `ChromiumBrowserService`, shared by both job kinds via `PdfRenderService`
 * — see that file's header for why the two numbers are deliberately not
 * the same thing.
 */
const WORKER_CONCURRENCY = 4;

@Injectable()
export class PdfWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PdfWorkerService.name);
  private worker?: Worker;
  private connection?: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly renderer: PdfRenderService,
    private readonly exportWorker: RecordsExportWorkerService,
  ) {}

  onModuleInit(): void {
    const connection = buildBullConnection(this.config);
    this.connection = connection;
    this.worker = new Worker(
      PDF_QUEUE_NAME,
      async (job: Job) => {
        if (job.name === 'render') {
          const { recordId } = job.data as PdfRenderJobPayload;
          const pdf = await this.renderer.renderRecordPdf(recordId);
          return { pdfBase64: pdf.toString('base64') };
        }
        if (job.name === 'export') {
          const { exportId } = job.data as PdfExportJobPayload;
          return this.exportWorker.processExport(exportId);
        }
        this.logger.warn(`unrecognised job name on ${PDF_QUEUE_NAME}: ${job.name}`);
        return undefined;
      },
      { connection, prefix: bullQueuePrefix(this.config), concurrency: WORKER_CONCURRENCY },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`pdf job ${job?.id} (${job?.name}) failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    if (this.connection && this.connection.status !== 'end') {
      await this.connection.quit();
    }
  }
}
