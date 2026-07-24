import { z } from 'zod';

/**
 * Mirrors DBD §5 `frequency_t`. Values are intervals in months: 1, 3, 6, 12.
 * Adding a value is forward-only, matching the database enum (DBD §5).
 */
export const frequencySchema = z.enum(['M1', 'M3', 'M6', 'Y']);

export type Frequency = z.infer<typeof frequencySchema>;

/**
 * PR-053's cascade is a divisibility rule over interval *lengths*, not a
 * hardcoded per-frequency table (U-CAS-07: introducing a new frequency must
 * not require changing cascade logic, only adding an entry here). This map
 * is DATA the cascade function is called with — see
 * `api/src/scheduling/frequency-cascade.ts`.
 */
export const FREQUENCY_INTERVAL_MONTHS: Record<Frequency, number> = {
  M1: 1,
  M3: 3,
  M6: 6,
  Y: 12,
};

/** Ascending by interval — the canonical order `job.frequency_scope` is stored in
 * (PR-052's idempotency key compares the array positionally, so two runs
 * computing the same set in a different order must not be treated as different). */
export function sortFrequencies(frequencies: readonly Frequency[]): Frequency[] {
  return [...frequencies].sort(
    (a, b) => FREQUENCY_INTERVAL_MONTHS[a] - FREQUENCY_INTERVAL_MONTHS[b],
  );
}
