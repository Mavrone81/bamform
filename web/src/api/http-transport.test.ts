import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpSyncTransport } from './http-transport';
import { _resetForTests, setAccessToken } from '../auth/token-store';
import {
  isPasswordChangeRequired,
  _resetForTests as resetPasswordGate,
} from '../auth/password-change-gate';

/** `clone()` is part of the contract now: `authorizedFetch` reads a 403 body
 * to spot `/errors/password-change-required` and must leave the original
 * response readable for the caller. */
function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 401): Response {
  return {
    ok,
    status,
    json: async () => body,
    clone: () => jsonResponse(body, ok, status),
  } as Response;
}

beforeEach(() => {
  _resetForTests();
  resetPasswordGate();
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

  // ---- Slice 11b: verifier queue / record review / delegations ----

  it('getJob fetches GET /jobs/{jobId} and returns the parsed Job', async () => {
    setAccessToken('tok', 900);
    const job = {
      id: 'job-1',
      jobNumber: 'PM-2026-000431',
      assetCode: 'AW03',
      status: 'SUBMITTED',
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(job));

    const transport = new HttpSyncTransport();
    const result = await transport.getJob('job-1');
    expect(result).toEqual(job);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/jobs/job-1');
  });

  it('getJob throws a TransportError on a non-OK response', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 404));
    const transport = new HttpSyncTransport();
    await expect(transport.getJob('job-1')).rejects.toThrow('getJob failed: 404');
  });

  it('getQueue calls GET /queue and returns the page', async () => {
    setAccessToken('tok', 900);
    const page = { data: [{ id: 'job-1' }], page: { hasMore: false, limit: 50 } };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(page));

    const transport = new HttpSyncTransport();
    const result = await transport.getQueue();
    expect(result).toEqual(page);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/queue');
    expect(String(url)).not.toContain('?');
  });

  it('getQueue appends limit/cursor as query parameters when given', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ data: [], page: { hasMore: false, limit: 10 } }),
    );
    const transport = new HttpSyncTransport();
    await transport.getQueue({ limit: 10, cursor: 'abc' });
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('limit=10');
    expect(String(url)).toContain('cursor=abc');
  });

  it('getQueue throws a TransportError on a non-OK response', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 500));
    const transport = new HttpSyncTransport();
    await expect(transport.getQueue()).rejects.toThrow('getQueue failed: 500');
  });

  it('verifyJob posts the drawnSignature body with an Idempotency-Key and returns ok:true on success', async () => {
    setAccessToken('tok', 900);
    const job = { id: 'job-1', status: 'ARCHIVED' };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(job));

    const transport = new HttpSyncTransport();
    const result = await transport.verifyJob(
      'job-1',
      { drawnSignature: 'data:image/png;base64,AAA' },
      'idem-verify-1',
    );
    expect(result).toEqual({ status: 200, ok: true, body: job });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/jobs/job-1/verify');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Headers).get('Idempotency-Key')).toBe('idem-verify-1');
    expect(JSON.parse(init?.body as string)).toEqual({
      drawnSignature: 'data:image/png;base64,AAA',
    });
  });

  it('verifyJob generates an Idempotency-Key when one is not supplied', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: 'job-1' }));
    const transport = new HttpSyncTransport();
    await transport.verifyJob('job-1', { drawnSignature: 'data:image/png;base64,AAA' });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Headers).get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('verifyJob returns ok:false with the Problem on a 403 step-up-required response', async () => {
    setAccessToken('tok', 900);
    const problem = {
      type: 'https://form.bevorasg.com/errors/step-up-required',
      title: 'Step-up required',
      status: 403,
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(problem, false, 403));
    const transport = new HttpSyncTransport();
    const result = await transport.verifyJob('job-1', {
      drawnSignature: 'data:image/png;base64,AAA',
    });
    expect(result).toEqual({ status: 403, ok: false, problem });
  });

  it('returnJob posts the reason and returns ok:true on success', async () => {
    setAccessToken('tok', 900);
    const job = { id: 'job-1', status: 'IN_PROGRESS' };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(job));

    const transport = new HttpSyncTransport();
    const result = await transport.returnJob(
      'job-1',
      'Torque reading out of tolerance, rework needed.',
      'idem-return-1',
    );
    expect(result).toEqual({ status: 200, ok: true, body: job });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/jobs/job-1/return');
    expect(JSON.parse(init?.body as string)).toEqual({
      reason: 'Torque reading out of tolerance, rework needed.',
    });
  });

  it('returnJob returns ok:false with the Problem on a 422 (reason too short)', async () => {
    setAccessToken('tok', 900);
    const problem = { type: 'about:blank', title: 'reason too short', status: 422 };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(problem, false, 422));
    const transport = new HttpSyncTransport();
    const result = await transport.returnJob('job-1', 'too short');
    expect(result).toEqual({ status: 422, ok: false, problem });
  });

  it('getDelegations calls GET /delegations and returns the page', async () => {
    setAccessToken('tok', 900);
    const page = { data: [{ id: 'deleg-1' }], page: { hasMore: false, limit: 50 } };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(page));
    const transport = new HttpSyncTransport();
    const result = await transport.getDelegations();
    expect(result).toEqual(page);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/delegations');
  });

  it('createDelegation posts the request body and returns ok:true with the created Delegation', async () => {
    setAccessToken('tok', 900);
    const delegation = {
      id: 'deleg-1',
      delegatorId: 'user-2',
      delegateId: 'user-4',
      validFrom: '2026-07-25T00:00:00Z',
      validTo: '2026-08-01T00:00:00Z',
      createdBy: 'user-2',
      revokedAt: null,
      createdAt: '2026-07-25T00:00:00Z',
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(delegation, true, 201));
    const transport = new HttpSyncTransport();
    const result = await transport.createDelegation({
      delegatorId: 'user-2',
      delegateId: 'user-4',
      validFrom: '2026-07-25T00:00:00Z',
      validTo: '2026-08-01T00:00:00Z',
    });
    expect(result).toEqual({ status: 201, ok: true, body: delegation });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/delegations');
    expect(init?.method).toBe('POST');
  });

  it('createDelegation returns ok:false with the Problem on a 403', async () => {
    setAccessToken('tok', 900);
    const problem = { type: 'about:blank', title: 'forbidden', status: 403 };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(problem, false, 403));
    const transport = new HttpSyncTransport();
    const result = await transport.createDelegation({
      delegatorId: 'user-9',
      delegateId: 'user-4',
      validFrom: '2026-07-25T00:00:00Z',
      validTo: '2026-08-01T00:00:00Z',
    });
    expect(result).toEqual({ status: 403, ok: false, problem });
  });

  it('revokeDelegation sends DELETE /delegations/{id} and returns ok:true with the revoked Delegation', async () => {
    setAccessToken('tok', 900);
    const delegation = { id: 'deleg-1', revokedAt: '2026-07-25T01:00:00Z' };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(delegation));
    const transport = new HttpSyncTransport();
    const result = await transport.revokeDelegation('deleg-1');
    expect(result).toEqual({ status: 200, ok: true, body: delegation });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/delegations/deleg-1');
    expect(init?.method).toBe('DELETE');
  });
});

/**
 * U-TRANS-01 — brief §2.3: the forced-password-change 403 is detected once,
 * centrally, in the transport layer, "not scattered across screens". Every
 * authenticated request in this app goes through `authorizedFetch`, so these
 * assertions cover the whole surface rather than the two endpoints named.
 */
describe('U-TRANS-01: the forced-password-change 403 is intercepted centrally', () => {
  const passwordChangeProblem = {
    type: '/errors/password-change-required',
    title: 'Password change required',
    status: 403,
    detail: 'Your password was set by an administrator.',
  };

  it('latches the gate on a 403 password-change-required from a plain GET', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(passwordChangeProblem, false, 403));

    const transport = new HttpSyncTransport();
    await expect(transport.bootstrap()).rejects.toThrow('bootstrap failed: 403');

    expect(isPasswordChangeRequired()).toBe(true);
  });

  it('latches it from an action endpoint too, and still hands the caller a readable body', async () => {
    setAccessToken('tok', 900);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(passwordChangeProblem, false, 403));

    const transport = new HttpSyncTransport();
    const result = await transport.verifyJob('job-1', {
      drawnSignature: 'data:image/png;base64,x',
    });

    // The interception reads a CLONE — the original response body is intact.
    expect(result).toEqual({ status: 403, ok: false, problem: passwordChangeProblem });
    expect(isPasswordChangeRequired()).toBe(true);
  });

  it('does NOT latch on an unrelated 403 — a step-up prompt must not become a password change', async () => {
    setAccessToken('tok', 900);
    const stepUp = {
      type: 'https://form.bevorasg.com/errors/step-up-required',
      title: 'Re-authentication required before signing',
      status: 403,
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(stepUp, false, 403));

    const transport = new HttpSyncTransport();
    const result = await transport.verifyJob('job-1', {
      drawnSignature: 'data:image/png;base64,x',
    });

    expect(result.problem).toEqual(stepUp);
    expect(isPasswordChangeRequired()).toBe(false);
  });

  it('does not latch on a 403 whose body is not JSON at all', async () => {
    setAccessToken('tok', 900);
    const broken = {
      ok: false,
      status: 403,
      json: async () => {
        throw new SyntaxError('not json');
      },
      clone: () => broken,
    } as unknown as Response;
    vi.mocked(fetch).mockResolvedValueOnce(broken);

    const transport = new HttpSyncTransport();
    const result = await transport.returnJob('job-1', 'a reason long enough');

    expect(result.status).toBe(403);
    expect(isPasswordChangeRequired()).toBe(false);
  });
});
