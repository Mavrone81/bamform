import { Injectable, Logger } from '@nestjs/common';
import type { NotificationTransport, SendNotificationParams } from './notification-transport';

/**
 * `NOTIFICATION_ENABLED=false` path (ENVIRONMENT_REQUIREMENTS.md: "false in
 * CI and local — prevents test runs emailing real staff", PR-ENV-09). Never
 * opens a socket, never reads the `smtp_password` secret. Logs only the
 * template code and recipient id — NEVER a decrypted email address
 * (`NotificationDispatchService` calls `send()` with the address already
 * resolved, but this transport does not log `params.to`) — so a CI run
 * proves "a send was attempted" without leaking personal data into log
 * output (mirrors `common/logging/redact.ts`'s no-PII rule).
 */
@Injectable()
export class NoopNotificationTransport implements NotificationTransport {
  readonly kind = 'noop' as const;
  private readonly logger = new Logger(NoopNotificationTransport.name);

  async send(params: SendNotificationParams): Promise<void> {
    this.logger.log(`NOTIFICATION_ENABLED=false — would send "${params.subject}" (not sent)`);
  }
}
