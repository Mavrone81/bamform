import { getAccessToken, ensureFreshToken, refresh } from '../auth/index';
import {
  isPasswordChangeRequiredProblem,
  markPasswordChangeRequired,
} from '../auth/password-change-gate';
import { TransportError } from './transport';
import { API_BASE } from './config';
import { uuidv7 } from '../lib/uuidv7';
import type {
  SyncTransport,
  OutboxMutation,
  DrainOutboxResponse,
  SubmitJobResponse,
  SyncBootstrap,
  Job,
  QueuePage,
  DelegationsPage,
  JobActionResponse,
  DelegationActionResponse,
  VerifyJobRequest,
  SubmitJobRequest,
  CreateAdhocJobRequest,
  CreateDelegationRequest,
  Problem,
  Attachment,
  AttachmentUploadOptions,
  AttachmentUploadResult,
} from './transport';

/**
 * Exported for `admin-client.ts` (slice 13-UI-B): the admin surface's calls
 * must ride the SAME seam as every other authenticated request — bearer
 * attachment, the one-shot silent 401-refresh, and the forced-password-change
 * latch below — rather than growing a second, subtly different fetch wrapper.
 */
export async function authorizedFetch(
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

  // Slice 13-MFA §7 / review finding I-3: a user whose password was set by an
  // administrator is refused `403 /errors/password-change-required` by a
  // GLOBAL server-side guard, on every endpoint except `/auth/me`,
  // `/auth/password` and `/auth/logout`. Detecting it here — the single
  // function every authenticated request in this app already passes through —
  // is what keeps that check out of ~10 screens and makes a screen added in a
  // future slice inherit it for free.
  //
  // This is not an authorisation decision (#6): it latches what the server
  // just said, and `changePassword` clears the latch when the server accepts
  // the new password. `clone()` because the caller still has to read the body.
  if (res.status === 403) {
    const problem = await res
      .clone()
      .json()
      .catch(() => undefined);
    if (isPasswordChangeRequiredProblem(problem)) markPasswordChangeRequired();
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

  async submitJob(
    jobId: string,
    idempotencyKey: string,
    request: SubmitJobRequest,
  ): Promise<SubmitJobResponse> {
    const res = await authorizedFetch(`/jobs/${jobId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request),
    });
    if (res.ok) {
      return { status: res.status, ok: true, body: await res.json() };
    }
    const problem = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }

  async createAdhocJob(request: CreateAdhocJobRequest): Promise<JobActionResponse> {
    const res = await authorizedFetch('/jobs/adhoc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (res.ok) {
      return { status: res.status, ok: true, body: (await res.json()) as Job };
    }
    const problem: Problem | undefined = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }

  async getJob(jobId: string): Promise<Job> {
    const res = await authorizedFetch(`/jobs/${jobId}`);
    if (!res.ok) {
      // Status attached (H-3): conflict recovery needs to distinguish a
      // 403/404 (job reassigned away / removed — recovery by resend can
      // never succeed) from an unreachable server.
      throw new TransportError(`getJob failed: ${res.status}`, undefined, res.status);
    }
    return (await res.json()) as Job;
  }

  async getQueue(params?: { limit?: number; cursor?: string }): Promise<QueuePage> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    const res = await authorizedFetch(`/queue${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
      throw new TransportError(`getQueue failed: ${res.status}`);
    }
    return (await res.json()) as QueuePage;
  }

  async verifyJob(
    jobId: string,
    request: VerifyJobRequest,
    idempotencyKey: string = uuidv7(),
  ): Promise<JobActionResponse> {
    const res = await authorizedFetch(`/jobs/${jobId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(request),
    });
    if (res.ok) {
      return { status: res.status, ok: true, body: await res.json() };
    }
    const problem: Problem | undefined = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }

  async returnJob(
    jobId: string,
    reason: string,
    idempotencyKey: string = uuidv7(),
  ): Promise<JobActionResponse> {
    const res = await authorizedFetch(`/jobs/${jobId}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      return { status: res.status, ok: true, body: await res.json() };
    }
    const problem: Problem | undefined = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }

  /**
   * XMLHttpRequest, deliberately: it is the only platform transport that
   * reports UPLOAD progress (fetch reports download only), and a multi-MB
   * photo over plant WiFi needs a truthful progress bar. Zero-dependency,
   * same-origin, same cookie semantics (`withCredentials`).
   *
   * Auth (H-5): the bearer is pre-flighted through `ensureFreshToken`
   * (which refreshes a stale-but-present token, not only an absent one),
   * and a 401 response triggers ONE refresh + ONE retry — mirroring
   * `authorizedFetch`'s behaviour, which XHR cannot reuse directly.
   * Without the retry, a token expiring while the capture screen sits
   * open makes every upload (and every manual Retry) replay the same
   * stale bearer into the same 401 forever. Same idempotency key on the
   * retry: it is a replay of this upload, never a second one.
   */
  async uploadAttachment(
    jobId: string,
    file: Blob,
    opts: AttachmentUploadOptions,
  ): Promise<AttachmentUploadResult> {
    const token = await ensureFreshToken();
    const first = await this.uploadAttachmentOnce(jobId, file, opts, token);
    if (first.status !== 401) return first;
    const refreshed = await refresh();
    if (!refreshed) return first; // session is dead — an honest 401, no pointless replay
    return this.uploadAttachmentOnce(jobId, file, opts, refreshed.accessToken);
  }

  private uploadAttachmentOnce(
    jobId: string,
    file: Blob,
    opts: AttachmentUploadOptions,
    token: string | null,
  ): Promise<AttachmentUploadResult> {
    return new Promise<AttachmentUploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/jobs/${encodeURIComponent(jobId)}/attachments`);
      xhr.withCredentials = true;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Idempotency-Key', opts.idempotencyKey);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          opts.onProgress?.(event.loaded / event.total);
        }
      };
      xhr.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText) as unknown;
        } catch {
          body = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ status: xhr.status, ok: true, attachment: body as Attachment });
        } else {
          resolve({ status: xhr.status, ok: false, problem: body as Problem });
        }
      };
      xhr.onerror = () =>
        reject(new TransportError('uploadAttachment failed: network error before any response'));
      xhr.onabort = () => reject(new TransportError('uploadAttachment failed: aborted'));

      const form = new FormData();
      const filename = file instanceof File ? file.name : 'photo.jpg';
      form.append('file', file, filename);
      if (opts.itemResultId) form.append('itemResultId', opts.itemResultId);
      xhr.send(form);
    });
  }

  async getDelegations(): Promise<DelegationsPage> {
    const res = await authorizedFetch('/delegations');
    if (!res.ok) {
      throw new TransportError(`getDelegations failed: ${res.status}`);
    }
    return (await res.json()) as DelegationsPage;
  }

  async createDelegation(request: CreateDelegationRequest): Promise<DelegationActionResponse> {
    const res = await authorizedFetch('/delegations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (res.ok) {
      return { status: res.status, ok: true, body: await res.json() };
    }
    const problem: Problem | undefined = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }

  async revokeDelegation(delegationId: string): Promise<DelegationActionResponse> {
    const res = await authorizedFetch(`/delegations/${delegationId}`, { method: 'DELETE' });
    if (res.ok) {
      return { status: res.status, ok: true, body: await res.json() };
    }
    const problem: Problem | undefined = await res.json().catch(() => undefined);
    return { status: res.status, ok: false, problem };
  }
}
