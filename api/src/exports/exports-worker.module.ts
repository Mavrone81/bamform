import { Module } from '@nestjs/common';
import { PdfRenderModule } from '../pdf/pdf-render.module';
import { RecordExportRepository } from './record-export.repository';
import { RecordsExportWorkerService } from './records-export-worker.service';

/** WORKER-side export processing (PR-119) — imports `PdfRenderModule` so the export job renders through the same Chromium/semaphore pipeline a single PDF request uses. Never imported by `AppModule`. */
@Module({
  imports: [PdfRenderModule],
  providers: [RecordExportRepository, RecordsExportWorkerService],
  exports: [RecordsExportWorkerService],
})
export class ExportsWorkerModule {}
