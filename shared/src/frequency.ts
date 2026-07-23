import { z } from 'zod';

/**
 * Mirrors DBD §5 `frequency_t`. Values are intervals in months: 1, 3, 6, 12.
 * Adding a value is forward-only, matching the database enum (DBD §5).
 */
export const frequencySchema = z.enum(['M1', 'M3', 'M6', 'Y']);

export type Frequency = z.infer<typeof frequencySchema>;
