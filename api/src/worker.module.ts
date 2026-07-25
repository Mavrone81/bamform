import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { CryptoModule } from './crypto/crypto.module';
import { NotificationQueueModule } from './notifications/notification-queue.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PdfQueueModule } from './pdf/pdf-queue.module';
import { PdfWorkerModule } from './pdf/pdf-worker.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { MinioModule } from './storage/minio.module';

/**
 * The `bamform-worker` container's module graph (`worker.ts` is its
 * bootstrap) — deliberately narrower than `AppModule`: no `AuthModule`
 * (which registers the global `JwtAuthGuard` as `APP_GUARD` — meaningless
 * with no HTTP server), no `AreasModule`/`AssetTypesModule`/`AssetsModule`/
 * `TemplatesModule` (their controllers serve HTTP the worker never exposes).
 * `SchedulingModule` provides everything the worker actually runs
 * (`SchedulerService`); its `AssetScheduleController` comes along for the
 * ride but is inert here (`NestFactory.createApplicationContext` never
 * wires a router — see that module's own comment).
 *
 * Slice 11a adds `CryptoModule` directly (rather than via `AuthModule`,
 * which this worker deliberately excludes — see above): the worker needs
 * `FIELD_ENCRYPTION_SERVICE` to decrypt a notification recipient's email
 * (PR-106) but has no business pulling in JWT/login machinery to get it.
 * `NotificationQueueModule` (producer, `@Global`, PR-150/151) and
 * `NotificationsModule` (the CONSUMER — `NotificationWorkerService`'s BullMQ
 * `Worker`, only ever instantiated here, never in `AppModule`) give the
 * worker the whole PR-009/PR-077 notification+escalation subsystem.
 *
 * Slice 12 adds `PdfQueueModule` (producer, `@Global`, PR-116/117/119 — same
 * "imported by both graphs" convention as `NotificationQueueModule`) and
 * `PdfWorkerModule` (the CONSUMER — `PdfWorkerService`'s BullMQ `Worker`,
 * which renders PDFs via Chromium and builds export ZIPs, only ever
 * instantiated here, never in `AppModule`). Also adds `MinioModule`
 * (`@Global`, ADR-007) directly — `AppModule` gets it for free via its own
 * import, but this worker needs `MinioService` too (the export job uploads
 * the finished ZIP) and, unlike `AppModule`, never imports anything else
 * that already pulls `MinioModule` in, so it must be listed here explicitly
 * (same reasoning as `CryptoModule` above).
 */
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
    CryptoModule,
    SchedulingModule,
    NotificationQueueModule,
    NotificationsModule,
    PdfQueueModule,
    PdfWorkerModule,
    MinioModule,
  ],
})
export class WorkerModule {}
