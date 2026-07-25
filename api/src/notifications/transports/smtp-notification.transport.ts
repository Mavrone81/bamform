import { createTransport, type Transporter } from 'nodemailer';
import type { NotificationTransport, SendNotificationParams } from './notification-transport';

export interface SmtpTransportConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

/**
 * The real SMTP relay (PR-009, UR-061..065). Constructed only when
 * `NOTIFICATION_ENABLED=true` (`notifications.module.ts`'s factory) — the
 * `smtp_password` secret (docs/ENVIRONMENT_REQUIREMENTS.md) is never read
 * unless this transport is actually selected, so a CI/local run with that
 * secret file absent never touches this class. Not a NestJS `@Injectable()`
 * (constructed with plain config inside a factory, not DI-resolved) —
 * mirrors `SmtpTransportConfig` being assembled from `ConfigService` +
 * `SecretFileLoader` at the factory call site.
 */
export class SmtpNotificationTransport implements NotificationTransport {
  readonly kind = 'smtp' as const;
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpTransportConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    });
    this.from = config.from;
  }

  async send(params: SendNotificationParams): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
  }
}
