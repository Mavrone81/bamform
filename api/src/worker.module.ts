import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
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
    SchedulingModule,
  ],
})
export class WorkerModule {}
