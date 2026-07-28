import { describe, expect, it } from 'vitest';
import { todayLocalIsoDate } from './local-date';

/**
 * Slice 18-WORKFLOW review, X-7 — the bug was a UTC/local mismatch, so the
 * cases that matter are the ones where the two dates differ.
 */
describe('todayLocalIsoDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(todayLocalIsoDate(new Date(2026, 6, 28, 12, 0, 0))).toBe('2026-07-28');
  });

  it('zero-pads single-digit months and days', () => {
    expect(todayLocalIsoDate(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
  });

  it('returns the LOCAL date, which is what a planner means by "today"', () => {
    // 02:00 local on the 28th. In any timezone ahead of UTC this instant is
    // still the 27th in UTC — the exact case that made a freshly raised job
    // born overdue.
    const earlyMorning = new Date(2026, 6, 28, 2, 0, 0);
    expect(todayLocalIsoDate(earlyMorning)).toBe('2026-07-28');
    expect(todayLocalIsoDate(earlyMorning)).toBe(
      `${earlyMorning.getFullYear()}-${String(earlyMorning.getMonth() + 1).padStart(2, '0')}-${String(
        earlyMorning.getDate(),
      ).padStart(2, '0')}`,
    );
  });

  it('late evening local does not roll forward either', () => {
    expect(todayLocalIsoDate(new Date(2026, 6, 28, 23, 30, 0))).toBe('2026-07-28');
  });
});
