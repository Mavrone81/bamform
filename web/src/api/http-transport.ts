import { getAccessToken, ensureFreshToken, refresh } from '../auth/index';
import { TransportError } from './transport';
import { API_BASE } from './config';
import type {
  SyncTransport,
  OutboxMutation,
  DrainOutboxResponse,
  SubmitJobResponse,
  SyncBootstrap,
} from './transport';

async function authorizedFetch(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const token = getAccessToken() ?? (await ensureFreshToken());
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });

  // Silent refresh on 401 (PR-088-adjacent behaviour): a 401 means the
  // server rejected this exact token right now, regardless of what our own
  // clock thinks its expiry is — so this unconditionally asks for a new one
  // rather than deferring to `ensureFreshToken`'s "only if stale" check.
  // One retry only, to avoid looping forever against a server that keeps
  // rejecting every token.
  if (res.status === 401 && attempt === 0) {
    const refreshed = await refresh();
    if (refreshed) return authorizedFetch(path, init, attempt + 1);
  }
  return res;
}

/**
 * The real `SyncTransport` implementation — targets the exact paths in
 * `api/openapi.yaml`. As of this branch, `/sync/bootstrap`, `/sync/outbox`
 * and `/jobs/**` are not implemented server-side (see transport.ts's module
 * doc) — calling them returns 404 today. Swapping in the finished backend
 * requires no change here or in any screen, because every caller already
 * goes through the `SyncTransport` interface.
 */
export class HttpSyncTransport implements SyncTransport {
  async bootstrap(since?: string): Promise<SyncBootstrap> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    const res = await authorizedFetch(`/sync/bootstrap${query}`);
    if (!res.ok) {
      throw new TransportError(`bootstrap failed: ${res.status}`);
    }
    return (await res.json()) as SyncBootstrap;
  }

  async drainOutbox(mutations: OutboxMutation[]): Promise<DrainOutboxResponse> {
    // The single Idempotency-Key header on this endpoint isn't meaningful
    // per api/openapi.yaml (each mutation inside the batch carries its own
    // id, which IS its idempotency key) — this call only needs standard
    // JSON headers.
    const res = await authorizedFetch('/sync/outbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations }),
    });
    if (!res.ok) {
      // A non-2xx for the WHOLE batch (e.g. 429, 5xx) is a transport-level
      // failure from the outbox's point of view — outbox.drain() treats any
      // thrown error here as "no response reached the client", which is
      // exactly right: we do not know per-mutation outcomes.
      throw new TransportError(`drainOutbox failed: ${res.status}`);
    }
    return (await res.json()) as DrainOutboxResponse;
  }

  async submitJob(jobId: string, idempotencyKey: string): Promise<SubmitJobResponse> {
    const res = await authorizedFetch(`/jobs/${jobId}/submit`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    if (res.ok) {
      return { status: res.status, ok: true, body: await res.json() };
    }
    const problem = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }
}
