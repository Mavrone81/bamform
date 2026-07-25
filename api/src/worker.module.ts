import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { CryptoModule } from './crypto/crypto.module';
import { NotificationQueueModule } from './notifications/notification-queue.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SchedulingModule } from './scheduling/scheduling.module';

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
  ],
})
export class WorkerModule {}
