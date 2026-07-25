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
    JobsModule,
    SyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
