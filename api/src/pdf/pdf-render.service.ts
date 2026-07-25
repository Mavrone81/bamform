import { Injectable } from '@nestjs/common';
import { ChromiumBrowserService } from './chromium-browser.service';
import { renderRecordHtml } from './pdf-html-template';
import { PdfRecordAssemblyService } from './pdf-record-assembly.service';

/**
 * WORKER-side orchestrator: assemble the record (`PdfRecordAssemblyService`)
 * -> render its HTML (`pdf-html-template.ts`) -> rasterise via Chromium
 * (`ChromiumBrowserService`, PR-117, concurrency-2-capped by its
 * `RenderSemaphore`). The single call site both the `render` job handler
 * (`pdf-worker.module.ts`) and the export job handler
 * (`records-export-worker.service.ts`) go through, so a bulk export renders
 * through the EXACT same pipeline — and therefore the exact same
 * concurrency cap — as a single `GET /records/{recordId}/pdf` call.
 */
@Injectable()
export class PdfRenderService {
  constructor(
    private readonly assembly: PdfRecordAssemblyService,
    private readonly chromium: ChromiumBrowserService,
  ) {}

  async renderRecordPdf(recordId: string): Promise<Buffer> {
    const input = await this.assembly.assemble(recordId);
    const html = renderRecordHtml(input);
    return this.chromium.renderPdf(html);
  }
}
