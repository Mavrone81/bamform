import { Module } from '@nestjs/common';
import { ChromiumBrowserService } from './chromium-browser.service';
import { PdfRecordAssemblyService } from './pdf-record-assembly.service';
import { PdfRenderService } from './pdf-render.service';

/**
 * WORKER-side rendering capability (PR-117): Chromium + record assembly +
 * the orchestrator that ties them together. Imported by BOTH the
 * `bamform-pdf` queue's `render`-job consumer (`pdf-worker.module.ts`) and
 * the `export`-job processor (`exports/exports-worker.module.ts`) — a bulk
 * export renders through the EXACT SAME `PdfRenderService` (and therefore
 * the same concurrency-2 `RenderSemaphore`) a single `GET
 * /records/{recordId}/pdf` call uses. Never imported by `AppModule`
 * (`api` must never construct `ChromiumBrowserService` — PR-117).
 */
@Module({
  providers: [ChromiumBrowserService, PdfRecordAssemblyService, PdfRenderService],
  exports: [PdfRenderService],
})
export class PdfRenderModule {}
