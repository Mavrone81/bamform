import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { buildBullConnection, bullQueuePrefix } from './bullmq-connection';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NOTIFICATION_QUEUE_NAME } from './notification.tokens';
import type { EscalationJobPayload, NotificationJobPayload } from './notification-payloads';

/**
 * The BullMQ CONSUMER (PR-150/151: the worker sends). Deliberately starts
 * unconditionally on `WorkerModule` boot — regardless of `NOTIFICATION_ENABLED`
 * — so a delayed escalation job still MATURES and gets a recorded dispatch
 * decision (`notification` row) even with real sending disabled; only the
 * TRANSPORT `NotificationDispatchService` is constructed with (see
 * `notifications.module.ts`'s factory) is gated by `NOTIFICATION_ENABLED`.
 * If the queue were only drained while `NOTIFICATION_ENABLED=true`, a CI/local
 * run (where it is always `false`, PR-ENV-09) could never exercise "an
 * unverified record past the window fires a notification" — the E-10
 * behaviour slice-11a-brief.md requires being testable.
 */
@Injectable()
export class NotificationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorkerService.name);
  private worker?: Worker;
  private connection?: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  onModuleInit(): void {
    const connection = buildBullConnection(this.config);
    this.connection = connection;
    this.worker = new Worker(
      NOTIFICATION_QUEUE_NAME,
      async (job: Job) => {
        if (job.name === 'notification') {
          await this.dispatch.dispatch(job.data as NotificationJobPayload);
          return;
        }
        if (job.name === 'escalation') {
          await this.dispatch.dispatchEscalation(job.data as EscalationJobPayload);
          return;
        }
        this.logger.warn(`unrecognised job name on ${NOTIFICATION_QUEUE_NAME}: ${job.name}`);
      },
      { connection, prefix: bullQueuePrefix(this.config) },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`notification job ${job?.id} (${job?.name}) failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    // `Worker#close()` alone leaves the raw ioredis connection's socket open
    // — same empirically-verified BullMQ quirk `NotificationQueueModule`
    // documents; explicitly quit the connection this service itself holds.
    if (this.connection && this.connection.status !== 'end') {
      await this.connection.quit();
    }
  }
}
