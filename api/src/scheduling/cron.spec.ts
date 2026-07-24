import { cronMatches, parseCronExpression } from './cron';

describe('cron expression matcher', () => {
  it('parses 5 space-separated fields', () => {
    expect(parseCronExpression('0 * * * *')).toEqual({
      minute: '0',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });

  it('rejects a malformed expression', () => {
    expect(() => parseCronExpression('0 * * *')).toThrow(/expected 5/);
  });

  it('SCHEDULER_CRON default "0 * * * *" matches only on the hour', () => {
    expect(cronMatches('0 * * * *', new Date(2026, 6, 24, 9, 0))).toBe(true);
    expect(cronMatches('0 * * * *', new Date(2026, 6, 24, 9, 1))).toBe(false);
    expect(cronMatches('0 * * * *', new Date(2026, 6, 24, 23, 0))).toBe(true);
  });

  it('matches a specific hour', () => {
    expect(cronMatches('0 2 * * *', new Date(2026, 6, 24, 2, 0))).toBe(true);
    expect(cronMatches('0 2 * * *', new Date(2026, 6, 24, 3, 0))).toBe(false);
  });

  it('matches a step expression (*/15)', () => {
    expect(cronMatches('*/15 * * * *', new Date(2026, 6, 24, 9, 0))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2026, 6, 24, 9, 15))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2026, 6, 24, 9, 20))).toBe(false);
  });

  it('matches a list (1,15,30)', () => {
    expect(cronMatches('1,15,30 * * * *', new Date(2026, 6, 24, 9, 15))).toBe(true);
    expect(cronMatches('1,15,30 * * * *', new Date(2026, 6, 24, 9, 16))).toBe(false);
  });

  it('matches a range (9-17 for hour)', () => {
    expect(cronMatches('0 9-17 * * *', new Date(2026, 6, 24, 12, 0))).toBe(true);
    expect(cronMatches('0 9-17 * * *', new Date(2026, 6, 24, 18, 0))).toBe(false);
  });

  it('matches day-of-week (0 = Sunday)', () => {
    const sunday = new Date(2026, 6, 26); // 26 Jul 2026 is a Sunday
    expect(sunday.getDay()).toBe(0);
    expect(cronMatches('0 0 * * 0', sunday)).toBe(true);
    const monday = new Date(2026, 6, 27);
    expect(cronMatches('0 0 * * 0', monday)).toBe(false);
  });
});
