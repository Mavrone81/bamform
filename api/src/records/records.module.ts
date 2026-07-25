import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { RecordsController } from '../jobs/records.controller';
import { PdfModule } from '../pdf/pdf.module';
import { RecordsRepository } from './records.repository';
import { RecordsService } from './records.service';

/**
 * `api`-side archive read surface (UR-055/056/058, PR-116..118):
 * `GET /records`, `GET /records/{recordId}`, `GET /records/{recordId}/integrity`
 * (pre-existing, slice 7) and `GET /records/{recordId}/pdf` (slice 12) —
 * all on `RecordsController` (still physically `jobs/records.controller.ts`,
 * unmoved to minimize diff noise; this module is its new home in the
 * Nest module graph — see `jobs.module.ts`'s doc comment for why it moved
 * out of `JobsModule`).
 */
@Module({
  imports: [JobsModule, PdfModule],
  controllers: [RecordsController],
  providers: [RecordsRepository, RecordsService],
  exports: [RecordsRepository, RecordsService],
})
export class RecordsModule {}
