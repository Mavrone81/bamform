import { Module } from '@nestjs/common';
import { PdfQueueModule } from '../pdf/pdf-queue.module';
import { RecordsModule } from '../records/records.module';
import { ExportsController } from './exports.controller';
import { RecordExportRepository } from './record-export.repository';
import { RecordsExportService } from './records-export.service';

/**
 * `api`-side export wiring (PR-119): `POST /records/export` resolves and
 * scopes the record-id snapshot (`RecordsModule`'s `RecordsRepository`,
 * area/role scope) and hands off to the worker (`PdfQueueModule`, `@Global`).
 * `MinioService`/`AuditEventService` come from the global `MinioModule`/
 * `AuditModule` — not re-declared here.
 */
@Module({
  imports: [RecordsModule, PdfQueueModule],
  controllers: [ExportsController],
  providers: [RecordExportRepository, RecordsExportService],
})
export class ExportsModule {}
