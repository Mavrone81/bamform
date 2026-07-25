import { Logger } from '@nestjs/common';
import { NoopNotificationTransport } from './noop-notification.transport';

describe('NoopNotificationTransport (NOTIFICATION_ENABLED=false path)', () => {
  it('reports kind "noop"', () => {
    expect(new NoopNotificationTransport().kind).toBe('noop');
  });

  it('resolves without throwing and never actually sends anything', async () => {
    const transport = new NoopNotificationTransport();
    await expect(
      transport.send({ to: 'someone@example.com', subject: 'x', text: 'y' }),
    ).resolves.toBeUndefined();
  });

  it('never logs the recipient address (PR-106 — no PII in logs)', async () => {
    const transport = new NoopNotificationTransport();
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await transport.send({
      to: 'secret-address@example.com',
      subject: 'Test subject',
      text: 'body',
    });
    for (const call of logSpy.mock.calls) {
      expect(String(call[0])).not.toContain('secret-address@example.com');
    }
    logSpy.mockRestore();
  });
});
