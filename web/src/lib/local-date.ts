/**
 * Today's date as the DEVICE sees it — `YYYY-MM-DD` in local time, not UTC.
 *
 * Slice 18-WORKFLOW review, finding X-7. "Raise a job" defaulted its due date
 * with `new Date().toISOString().slice(0, 10)`, which is the UTC date. In
 * Singapore (UTC+8) a planner raising work between 00:00 and 08:00 local time
 * got YESTERDAY's date, so the job was born overdue and immediately appeared
 * in the UR-068 overdue report.
 *
 * The tablet is physically in the plant, so its local date IS the plant's
 * date — which makes this the correct source for a human picking "today" by
 * hand, and needs no timezone configuration to get right. `due_on` is a DATE
 * column and the rest of the system stays UTC-consistent; this converts at
 * the one boundary where a person means "today" rather than "this instant".
 */
export function todayLocalIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
