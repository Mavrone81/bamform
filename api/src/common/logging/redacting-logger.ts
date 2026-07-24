import { ConsoleLogger } from '@nestjs/common';
import { redactSecrets } from './redact';

/**
 * S-15 / threat I-3 (TEST_PLAN §9, SEC §10.4): the app-wide logger. Wired in
 * `main.ts` via `app.useLogger(new RedactingLogger())` so every log call
 * anywhere in the application — not only call sites that remember to scrub
 * their own arguments — has secrets stripped before they reach stdout/stderr.
 */
export class RedactingLogger extends ConsoleLogger {
  private redactArgs(args: unknown[]): unknown[] {
    return args.map((arg) => redactSecrets(arg));
  }

  override log(message: unknown, ...optionalParams: unknown[]): void {
    const [redactedMessage, ...redactedParams] = this.redactArgs([message, ...optionalParams]);
    super.log(redactedMessage, ...(redactedParams as []));
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    const [redactedMessage, ...redactedParams] = this.redactArgs([message, ...optionalParams]);
    super.error(redactedMessage, ...(redactedParams as []));
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    const [redactedMessage, ...redactedParams] = this.redactArgs([message, ...optionalParams]);
    super.warn(redactedMessage, ...(redactedParams as []));
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    const [redactedMessage, ...redactedParams] = this.redactArgs([message, ...optionalParams]);
    super.debug(redactedMessage, ...(redactedParams as []));
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    const [redactedMessage, ...redactedParams] = this.redactArgs([message, ...optionalParams]);
    super.verbose(redactedMessage, ...(redactedParams as []));
  }
}
