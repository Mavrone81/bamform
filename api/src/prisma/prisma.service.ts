import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin Nest wrapper around PrismaClient. Connects on module init and
 * disconnects cleanly on shutdown so the api process never leaks pool
 * connections during a redeploy (docker-compose.yml health-checked restart).
 *
 * The api connects with the restricted `bamform_app` role (DATABASE_URL) —
 * never the migration role (DBD §7.1, BUILD_HANDOFF non-negotiable #7).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
