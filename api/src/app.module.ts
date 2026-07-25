import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health/health.controller';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './redis/redis.module';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { AreasModule } from './areas/areas.module';
import { AssetTypesModule } from './asset-types/asset-types.module';
import { AssetsModule } from './assets/assets.module';
import { TemplatesModule } from './templates/templates.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { MinioModule } from './storage/minio.module';
import { JobsModule } from './jobs/jobs.module';
import { SyncModule } from './sync/sync.module';
import { DelegationsModule } from './delegations/delegations.module';
import { QueueModule } from './queue/queue.module';
import { NotificationQueueModule } from './notifications/notification-queue.module';
import { PdfQueueModule } from './pdf/pdf-queue.module';
import { RecordsModule } from './records/records.module';
import { ExportsModule } from './exports/exports.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.NODE_ENV === 'test' ? undefined : '.env',
    }),
    PrismaModule,
    RedisModule,
    CommonModule,
    AuditModule,
    AuthModule,
    AreasModule,
    AssetTypesModule,
    AssetsModule,
    TemplatesModule,
    SchedulingModule,
    MinioModule,
    // Slice 11a — `NotificationQueueModule` (@Global, PRODUCER only: `api`
    // schedules/enqueues, never sends — PR-150/151) must be imported before
    // any module that injects `NotificationQueueService` at construction
    // time; listed here explicitly (Nest resolves by graph, not by array
    // order, but this keeps the "who provides what" story readable).
    NotificationQueueModule,
    // Slice 12 — `PdfQueueModule` (@Global, PRODUCER + `QueueEvents`: `api`
    // enqueues AND awaits — PR-116/117/119), same convention as
    // `NotificationQueueModule` above. Never `PdfRenderModule`/`PdfWorkerModule`
    // (worker-only, `WorkerModule` — `api` must never construct Chromium).
    PdfQueueModule,
    DelegationsModule,
    QueueModule,
    JobsModule,
    RecordsModule,
    ExportsModule,
    ReportsModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
