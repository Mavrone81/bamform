import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import type Redis from 'ioredis';
import { buildBullConnection, bullQueuePrefix } from '../notifications/bullmq-connection';
import { PDF_QUEUE, PDF_QUEUE_EVENTS, PDF_QUEUE_NAME } from './pdf.tokens';
import { PdfQueueService } from './pdf-queue.service';

const BULL_CONNECTION = Symbol('PDF_QUEUE_RAW_CONNECTION');
const QUEUE_EVENTS_CONNECTION = Symbol('PDF_QUEUE_EVENTS_RAW_CONNECTION');

/**
 * `@Global()`, imported by BOTH `AppModule` and `WorkerModule` — mirrors
 * `notification-queue.module.ts`'s convention exactly (see that file's doc
 * comment for why: one BullMQ connection graph per process, not two).
 * `api` uses `PdfQueueService` to enqueue AND to await completion
 * (`QueueEvents` — `Job#waitUntilFinished` needs one); `worker` only needs
 * the `Queue`/consumer side (`pdf-worker.module.ts`), but importing this
 * module there too costs nothing extra (the `QueueEvents` connection is
 * idle unless something calls `waitUntilFinished`, which the worker never
 * does) and keeps "one producer module, imported everywhere" consistent
 * with the established pattern.
 *
 * Closes both raw ioredis connections on `app.close()` — same
 * empirically-verified BullMQ quirk `notification-queue.module.ts`
 * documents (`Queue#close()`/`QueueEvents#close()` alone leave the ioredis
 * socket open).
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
      provide: QUEUE_EVENTS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => buildBullConnection(config),
    },
    {
      provide: PDF_QUEUE,
      inject: [ConfigService, BULL_CONNECTION],
      useFactory: (config: ConfigService, connection: Redis): Queue =>
        new Queue(PDF_QUEUE_NAME, { connection, prefix: bullQueuePrefix(config) }),
    },
    {
      provide: PDF_QUEUE_EVENTS,
      inject: [ConfigService, QUEUE_EVENTS_CONNECTION],
      useFactory: (config: ConfigService, connection: Redis): QueueEvents =>
        new QueueEvents(PDF_QUEUE_NAME, { connection, prefix: bullQueuePrefix(config) }),
    },
    PdfQueueService,
  ],
  exports: [PDF_QUEUE, PDF_QUEUE_EVENTS, PdfQueueService],
})
export class PdfQueueModule implements OnModuleDestroy {
  constructor(
    @Inject(PDF_QUEUE) private readonly queue: Queue,
    @Inject(PDF_QUEUE_EVENTS) private readonly queueEvents: QueueEvents,
    @Inject(BULL_CONNECTION) private readonly connection: Redis,
    @Inject(QUEUE_EVENTS_CONNECTION) private readonly queueEventsConnection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.queueEvents.close();
    if (this.connection.status !== 'end') {
      await this.connection.quit();
    }
    if (this.queueEventsConnection.status !== 'end') {
      await this.queueEventsConnection.quit();
    }
  }
}
