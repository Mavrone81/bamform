import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/** PRD §9 report surface (UR-067..070) — read-only, `api`-side only (no worker involvement). */
@Module({
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService],
})
export class ReportsModule {}
