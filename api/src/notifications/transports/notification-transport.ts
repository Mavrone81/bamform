export interface SendNotificationParams {
  to: string;
  subject: string;
  text: string;
}

/**
 * Seam so a real SMTP relay "plugs in via config with no code change"
 * (slice-11a-brief.md item 3) — `NotificationDispatchService` depends on
 * this interface only, never on `nodemailer` or `NOTIFICATION_ENABLED`
 * directly. `kind` is not persisted anywhere; it exists purely so a test can
 * assert WHICH transport a dispatch actually used without inspecting
 * private state.
 */
export interface NotificationTransport {
  readonly kind: 'smtp' | 'noop';
  send(params: SendNotificationParams): Promise<void>;
}
