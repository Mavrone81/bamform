/**
 * Slice 13-MFA fix pass (review finding I-1).
 *
 * Every `id` in this schema is a Postgres `uuid` column. Handing Prisma a
 * path segment that is not a UUID does not return "no such row" — it raises
 * `P2023 Inconsistent column data: Error creating UUID`, and with no global
 * exception filter registered that surfaces as a bare
 * `500 {"statusCode":500,"message":"Internal server error"}`, which is
 * neither RFC 9457 nor anything `api/openapi.yaml` documents.
 *
 * At the API boundary the two cases mean the same thing: the id in the path
 * does not identify a row, so the honest answer is the documented 404. Guard
 * the lookup with this predicate rather than letting the driver decide.
 *
 * (The 500-on-malformed-id behaviour is repo-wide and pre-dates this slice —
 * `GET /users/not-a-uuid`, `/assets/…`, `/areas/…`, `/jobs/…` and
 * `/templates/…` all do it on `origin/main`. Fixing it everywhere wants a
 * narrow global exception filter and is a change of its own; this file exists
 * so the endpoints this slice added are at least internally consistent —
 * unknown id and malformed id both give the documented 404.)
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
