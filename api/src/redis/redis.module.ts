import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * ADR-006: Redis 7 for rate limiting and the refresh-token-adjacent access
 * token `jti` denylist (PR-088). `REDIS_URL` is already in `.env.example`
 * (slice 1) — credential injection from the file-mounted `redis_password`
 * secret into the connection string is not yet wired anywhere in the
 * codebase (the same is true of `DATABASE_URL`/`postgres_password` since
 * slice 1's `PrismaService`); out of scope here — this module connects with
 * `REDIS_URL` exactly as slice 1's `PrismaService` connects with
 * `DATABASE_URL`, for parity.
 *
 * Implements `OnModuleDestroy` to close the client on `app.close()` —
 * without this, integration tests that boot the app leak an open Redis TCP
 * handle and Jest hangs past the test run ("did not exit one second after
 * the test run has completed").
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
        return new Redis(url, { maxRetriesPerRequest: 3 });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
