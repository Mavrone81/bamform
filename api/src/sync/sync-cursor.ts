import { validationFailedProblem } from '../common/domain-problems';

/**
 * `syncToken` (API_SPECIFICATION.md §11.1) — an opaque cursor the client
 * persists and may echo back. Encoded as base64 JSON `{"t": <serverTime ISO
 * string>}`, matching the spec's own worked example verbatim:
 * `eyJ0IjoiMjAyNi0wNy0yNFQwMjoxNTowMFoifQ` decodes to
 * `{"t":"2026-07-24T02:15:00Z"}` (confirmed by hand against the doc).
 */
export function encodeSyncToken(serverTime: Date): string {
  return Buffer.from(JSON.stringify({ t: serverTime.toISOString() }), 'utf8').toString('base64');
}

/** Returns `null` (never throws) on anything that isn't a well-formed token — callers decide how to react. */
export function decodeSyncToken(token: string): Date | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    const t = (parsed as { t?: unknown } | null)?.t;
    if (typeof t !== 'string') return null;
    const date = new Date(t);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * `GET /sync/bootstrap?since=…` — `api/openapi.yaml` documents `since` as a
 * raw `format: date-time` query parameter (the openapi contract is
 * authoritative, BUILD_HANDOFF §1), so that is the primary accepted form.
 * Also accepts an echoed `syncToken` (which itself encodes an ISO
 * timestamp) as a defensive fallback, since PR-059 describes the client
 * persisting and re-presenting the cursor it was last given — the two forms
 * carry the same information and either is safe to accept.
 */
export function parseSince(since: string | undefined): Date | undefined {
  if (since === undefined) return undefined;

  const direct = new Date(since);
  if (!Number.isNaN(direct.getTime())) return direct;

  const decoded = decodeSyncToken(since);
  if (decoded) return decoded;

  throw validationFailedProblem('since must be a valid ISO 8601 date-time or syncToken.');
}
