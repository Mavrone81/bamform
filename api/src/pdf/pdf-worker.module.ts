import { Module } from '@nestjs/common';
import { ExportsWorkerModule } from '../exports/exports-worker.module';
import { PdfRenderModule } from './pdf-render.module';
import { PdfWorkerService } from './pdf-worker.service';

/**
 * WORKER-only wiring for the `bamform-pdf` queue's consumer (`PdfWorkerService`,
 * only ever instantiated here, never in `AppModule` — mirrors
 * `NotificationsModule`'s "consumer is worker-only" convention). `PdfQueueModule`
 * (the producer, `@Global`) is imported separately by `WorkerModule` itself
 * (same "one producer module imported by both graphs" pattern
 * `notification-queue.module.ts` establishes).
 */
@Module({
  imports: [PdfRenderModule, ExportsWorkerModule],
  providers: [PdfWorkerService],
})
export class PdfWorkerModule {}
