import { decodeSyncToken, encodeSyncToken, parseSince } from './sync-cursor';

describe('sync-cursor — syncToken opaque cursor (API_SPECIFICATION.md §11.1)', () => {
  it('encodes a server timestamp as base64 JSON, matching the spec example shape', () => {
    const token = encodeSyncToken(new Date('2026-07-24T02:15:00.000Z'));
    expect(Buffer.from(token, 'base64').toString('utf8')).toBe('{"t":"2026-07-24T02:15:00.000Z"}');
  });

  it('round-trips encode -> decode back to the same instant', () => {
    const original = new Date('2026-07-24T02:15:00.000Z');
    const decoded = decodeSyncToken(encodeSyncToken(original));
    expect(decoded?.toISOString()).toBe(original.toISOString());
  });

  it('decodeSyncToken returns null for garbage input rather than throwing', () => {
    expect(decodeSyncToken('not-base64-json!!!')).toBeNull();
  });

  it('decodeSyncToken returns null when the decoded JSON has no usable `t`', () => {
    const token = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64');
    expect(decodeSyncToken(token)).toBeNull();
  });

  it('decodeSyncToken returns null when `t` is not a valid date string', () => {
    const token = Buffer.from(JSON.stringify({ t: 'not-a-date' }), 'utf8').toString('base64');
    expect(decodeSyncToken(token)).toBeNull();
  });
});

describe('parseSince — GET /sync/bootstrap?since=… (openapi: format date-time)', () => {
  it('returns undefined when since is not supplied (full bootstrap)', () => {
    expect(parseSince(undefined)).toBeUndefined();
  });

  it('accepts a raw ISO date-time string, per the documented query param', () => {
    const parsed = parseSince('2026-07-20T09:00:00Z');
    expect(parsed?.toISOString()).toBe('2026-07-20T09:00:00.000Z');
  });

  it('also accepts an echoed opaque syncToken (defensive — the client may pass the cursor back verbatim)', () => {
    const token = encodeSyncToken(new Date('2026-07-24T02:15:00.000Z'));
    const parsed = parseSince(token);
    expect(parsed?.toISOString()).toBe('2026-07-24T02:15:00.000Z');
  });

  it('throws a validation-failed problem for an unparseable since value', () => {
    expect(() => parseSince('definitely-not-a-date')).toThrow();
  });
});
