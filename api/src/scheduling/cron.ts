/**
 * Minimal 5-field cron expression matcher (`minute hour day-of-month month
 * day-of-week`) for `SCHEDULER_CRON` (default hourly —
 * ENVIRONMENT_REQUIREMENTS.md). Supports the wildcard, lists (`a,b`),
 * ranges (`a-b`) and steps (wildcard-or-range followed by a slash and a
 * step count) — the subset every standard 5-field cron expression is built
 * from.
 *
 * The worker (`worker.ts`) ticks on a short fixed interval and calls
 * `cronMatches(expr, now)` each tick, firing the scheduler once per matching
 * minute (guarded there against re-firing within the same minute) — this
 * avoids computing "next fire time" arithmetic across month/DST boundaries
 * entirely, at the cost of needing a tick granularity finer than a minute.
 */

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression (expected 5 space-separated fields, got ${parts.length}): "${expression}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function matchesPart(part: string, value: number, min: number, max: number): boolean {
  let range = part;
  let step = 1;

  if (part.includes('/')) {
    const [rangePart, stepPart] = part.split('/');
    range = rangePart;
    step = Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step "${part}"`);
    }
  }

  let lo = min;
  let hi = max;
  if (range !== '*') {
    if (range.includes('-')) {
      const [loStr, hiStr] = range.split('-');
      lo = Number(loStr);
      hi = Number(hiStr);
    } else {
      lo = Number(range);
      hi = lo;
    }
  }

  if (Number.isNaN(lo) || Number.isNaN(hi) || value < lo || value > hi) {
    return false;
  }
  return (value - lo) % step === 0;
}

function matchesField(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((part) => matchesPart(part, value, min, max));
}

/** True when `date` (local time) satisfies every field of `expression`. */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = parseCronExpression(expression);
  return (
    matchesField(fields.minute, date.getMinutes(), 0, 59) &&
    matchesField(fields.hour, date.getHours(), 0, 23) &&
    matchesField(fields.dayOfMonth, date.getDate(), 1, 31) &&
    matchesField(fields.month, date.getMonth() + 1, 1, 12) &&
    matchesField(fields.dayOfWeek, date.getDay(), 0, 6)
  );
}
