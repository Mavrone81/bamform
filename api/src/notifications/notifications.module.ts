import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueModule } from '../queue/queue.module';
import { SecretFileLoader } from '../secret-loading/secret-loader';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationWorkerService } from './notification-worker.service';
import { NOTIFICATION_TRANSPORT } from './notification.tokens';
import { NoopNotificationTransport } from './transports/noop-notification.transport';
import { SmtpNotificationTransport } from './transports/smtp-notification.transport';
import type { NotificationTransport } from './transports/notification-transport';

/**
 * WORKER-ONLY (imported by `WorkerModule`, never `AppModule` — PR-150/151:
 * the worker sends notifications, `api` only schedules via
 * `NotificationQueueModule`'s producer, which stays `@Global()`/imported by
 * both). Provides the consumer (`NotificationWorkerService`) and the
 * transport `NOTIFICATION_ENABLED` selects between.
 *
 * `smtp_password` (a file-mounted secret, `SecretFileLoader`) is read ONLY
 * inside the `true` branch — a CI/local run (`NOTIFICATION_ENABLED=false`,
 * PR-ENV-09) never touches that secret file, so it can be entirely absent
 * (as it is: `scripts/dev/generate-dev-secrets.sh` does not generate one —
 * see slice-11a-report.md) without breaking anything.
 */
@Module({
  imports: [QueueModule],
  providers: [
    NotificationDispatchService,
    NotificationWorkerService,
    {
      provide: NOTIFICATION_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): NotificationTransport => {
        const enabled = (config.get<string>('NOTIFICATION_ENABLED') ?? 'false') === 'true';
        if (!enabled) {
          return new NoopNotificationTransport();
        }
        const password = new SecretFileLoader().load('smtp_password').toString('utf8').trim();
        return new SmtpNotificationTransport({
          host: config.get<string>('SMTP_HOST') ?? '',
          port: Number(config.get('SMTP_PORT') ?? 587),
          user: config.get<string>('SMTP_USER') ?? '',
          password,
          from: config.get<string>('SMTP_FROM') ?? '',
        });
      },
    },
  ],
})
export class NotificationsModule {}
