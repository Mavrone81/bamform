/**
 * Cursor-based pagination (API_SPECIFICATION.md §6, PR-API-14/15): opaque
 * base64 cursor over a row's `id`. Every id in this schema is a UUIDv7
 * (time-ordered, PR-DBD's `uuidv7()` default), so `ORDER BY id ASC` plus
 * "cursor = last id returned" is a valid, non-duplicating, non-gapping
 * pagination key without a separate `created_at` column to sort by.
 *
 * Callers query `limit + 1` rows ordered by `id ASC` (optionally
 * `WHERE id > cursor`) and pass the result straight to `paginate()`.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface Page<T> {
  data: T[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}

/** Clamps a client-supplied `?limit=` to [1, 100], defaulting to 25 (PR-API-14). */
export function normaliseLimit(limit: unknown): number {
  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** Clients "must not construct or parse" the cursor (PR-API-14) — an invalid one is just ignored. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes `limit + 1` rows (the caller's over-fetch-by-one convention) ordered
 * by `id ASC` and slices them into a page, so `hasMore` is known without a
 * separate COUNT query.
 */
export function paginate<T extends { id: string }>(
  rowsFetchedLimitPlusOne: T[],
  limit: number,
): Page<T> {
  const hasMore = rowsFetchedLimitPlusOne.length > limit;
  const data = hasMore ? rowsFetchedLimitPlusOne.slice(0, limit) : rowsFetchedLimitPlusOne;
  const nextCursor = hasMore ? encodeCursor(data[data.length - 1].id) : null;
  return { data, page: { nextCursor, hasMore, limit } };
}
