import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { PdfCoordinatorService } from './pdf-coordinator.service';
import { PdfQueueModule } from './pdf-queue.module';

/**
 * `api`-side PDF wiring (PR-116/117/118): `PdfCoordinatorService` validates
 * and hands off to the worker via `PdfQueueService` (`PdfQueueModule`,
 * `@Global` — imported here too for explicitness even though its exports
 * are already available application-wide once `AppModule` imports it once).
 * Never provides `ChromiumBrowserService`/`PdfRenderService` — those are
 * `PdfRenderModule`, worker-only (see that file).
 */
@Module({
  imports: [JobsModule, PdfQueueModule],
  providers: [PdfCoordinatorService],
  exports: [PdfCoordinatorService],
})
export class PdfModule {}
