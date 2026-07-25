import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { buildBullConnection, bullQueuePrefix } from './bullmq-connection';
import { NOTIFICATION_QUEUE, NOTIFICATION_QUEUE_NAME } from './notification.tokens';
import { NotificationQueueService } from './notification-queue.service';

const BULL_CONNECTION = Symbol('NOTIFICATION_QUEUE_RAW_CONNECTION');

/**
 * `@Global()`, imported directly by BOTH `AppModule` and `WorkerModule`
 * (mirrors `RedisModule`'s own `@Global()` + direct-import-in-both
 * convention) — the PRODUCER side of PR-009's queue. `api` uses this to
 * schedule; `worker` ALSO imports it (via `NotificationsModule`, which
 * additionally provides the consumer) so `WorkerModule` has exactly one
 * BullMQ connection graph, not two independently-configured ones.
 *
 * Closes its ioredis connection on `app.close()` (mirrors `RedisModule`) so
 * integration tests that boot the app don't leak an open handle. `Queue
 * #close()` alone is NOT sufficient here — empirically verified (see
 * slice-11a-report.md): after `await queue.close()`, the RAW ioredis client
 * passed in as `connection` still reports `status: 'ready'` and its
 * underlying socket stays open (BullMQ's own internal `close()` does not
 * actually reach the exact client instance handed in, at least at
 * bullmq@5.81.2/ioredis@5.11.1) — a genuine Jest "did not exit" open-handle
 * leak was reproduced and fixed by explicitly `.quit()`-ing the SAME
 * `Redis` instance this module retains a reference to, in addition to
 * `queue.close()`.
 */
@Global()
@Module({
  providers: [
    {
      provide: BULL_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => buildBullConnection(config),
    },
    {
      provide: NOTIFICATION_QUEUE,
      inject: [ConfigService, BULL_CONNECTION],
      useFactory: (config: ConfigService, connection: Redis): Queue =>
        new Queue(NOTIFICATION_QUEUE_NAME, { connection, prefix: bullQueuePrefix(config) }),
    },
    NotificationQueueService,
  ],
  exports: [NOTIFICATION_QUEUE, NotificationQueueService],
})
export class NotificationQueueModule implements OnModuleDestroy {
  constructor(
    @Inject(NOTIFICATION_QUEUE) private readonly queue: Queue,
    @Inject(BULL_CONNECTION) private readonly connection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    if (this.connection.status !== 'end') {
      await this.connection.quit();
    }
  }
}
