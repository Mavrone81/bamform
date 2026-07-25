import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpSyncTransport } from './http-transport';
import { _resetForTests, setAccessToken } from '../auth/token-store';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 401): Response {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  _resetForTests();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpSyncTransport', () => {
  it('bootstrap sends the bearer token and returns the parsed payload', async () => {
    setAccessToken('tok', 900);
    const payload = {
      serverTime: '2026-01-01T00:00:00Z',
      user: { id: 'u', fullName: 'A', roles: [] },
      jobs: [],
      syncToken: 't',
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(payload));

    const transport = new HttpSyncTransport();
    const result = await transport.bootstrap();
    expect(result).toEqual(payload);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/sync/bootstrap');
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer tok');
  });

  it('bootstrap appends `since` as a query parameter', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        serverTime: 't',
        user: { id: 'u', fullName: 'A', roles: [] },
        jobs: [],
        syncToken: 't',
      }),
    );
    const transport = new HttpSyncTransport();
    await transport.bootstrap('2026-01-01T00:00:00Z');
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('since=2026-01-01');
  });

  it('bootstrap throws a TransportError on a non-OK response (drain/bootstrap callers treat this as "no ack")', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 500));
    const transport = new HttpSyncTransport();
    await expect(transport.bootstrap()).rejects.toThrow('bootstrap failed: 500');
  });

  it('drainOutbox posts the mutations array and returns the results', async () => {
    setAccessToken('tok', 900);
    const response = { results: [{ id: 'm1', status: 200, applied: true }], syncToken: 't2' };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(response));

    const transport = new HttpSyncTransport();
    const result = await transport.drainOutbox([
      { id: 'm1', sequence: 1, method: 'PUT', path: '/jobs/j/items/i', body: {} },
    ]);
    expect(result).toEqual(response);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/sync/outbox');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      mutations: [{ id: 'm1', sequence: 1, method: 'PUT', path: '/jobs/j/items/i', body: {} }],
    });
  });

  it('drainOutbox throws on a non-OK response, which the outbox module treats as a network failure', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 429));
    const transport = new HttpSyncTransport();
    await expect(transport.drainOutbox([])).rejects.toThrow('drainOutbox failed: 429');
  });

  it('submitJob sends the Idempotency-Key header and returns ok:true with the body on success', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'SUBMITTED' }));
    const transport = new HttpSyncTransport();
    const result = await transport.submitJob('job-1', 'idem-1');
    expect(result).toEqual({ status: 200, ok: true, body: { id: 'job-1', status: 'SUBMITTED' } });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/jobs/job-1/submit');
    expect((init?.headers as Headers).get('Idempotency-Key')).toBe('idem-1');
  });

  it('submitJob returns ok:false with the problem body on a non-OK response', async () => {
    setAccessToken('tok', 900);
    const problem = { type: 'about:blank', title: 'incomplete-record', status: 422 };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(problem, false, 422));
    const transport = new HttpSyncTransport();
    const result = await transport.submitJob('job-1', 'idem-2');
    expect(result).toEqual({ status: 422, ok: false, problem });
  });

  it('submitJob tolerates a non-OK response with an unparsable body', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const transport = new HttpSyncTransport();
    const result = await transport.submitJob('job-1', 'idem-3');
    expect(result).toEqual({ status: 500, ok: false, problem: undefined });
  });

  it('silently refreshes once and retries on a 401, then succeeds', async () => {
    setAccessToken('stale-tok', 900);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, false, 401)) // first bootstrap attempt
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: 'fresh-tok',
          expiresIn: 900,
          user: { id: 'u', fullName: 'A', roles: [] },
        }),
      ) // /auth/refresh
      .mockResolvedValueOnce(
        jsonResponse({
          serverTime: 't',
          user: { id: 'u', fullName: 'A', roles: [] },
          jobs: [],
          syncToken: 't',
        }),
      ); // retried bootstrap

    const transport = new HttpSyncTransport();
    const result = await transport.bootstrap();
    expect(result.syncToken).toBe('t');
    expect(fetch).toHaveBeenCalledTimes(3);
    const retryHeaders = vi.mocked(fetch).mock.calls[2][1]?.headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer fresh-tok');
  });

  it('does not loop forever if refresh itself cannot recover the 401', async () => {
    setAccessToken('stale-tok', 900);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({}, false, 401)) // bootstrap
      .mockResolvedValueOnce(jsonResponse({}, false, 401)); // refresh also rejected

    const transport = new HttpSyncTransport();
    await expect(transport.bootstrap()).rejects.toThrow('bootstrap failed: 401');
    expect(fetch).toHaveBeenCalledTimes(2); // one bootstrap attempt + one refresh, no retry loop
  });
});
