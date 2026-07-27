import type { components } from './generated/openapi-types';

export type OutboxMutation = components['schemas']['OutboxMutation'];
export type Attachment = components['schemas']['Attachment'];
export type OutboxResult = components['schemas']['OutboxResult'];
export type SyncBootstrap = components['schemas']['SyncBootstrap'];
export type Problem = components['schemas']['Problem'];
export type Job = components['schemas']['Job'];
export type QueueEntry = components['schemas']['QueueEntry'];
export type Delegation = components['schemas']['Delegation'];
export type CreateDelegationRequest = components['schemas']['CreateDelegationRequest'];
export type VerifyJobRequest = components['schemas']['VerifyJobRequest'];

export interface DrainOutboxResponse {
  results: OutboxResult[];
  syncToken?: string;
}

export interface SubmitJobResponse {
  status: number;
  ok: boolean;
  body?: unknown;
  problem?: Problem;
}

export interface PageMeta {
  nextCursor?: string | null;
  hasMore: boolean;
  limit: number;
  total?: number | null;
}

export interface QueuePage {
  data: QueueEntry[];
  page: PageMeta;
}

export interface DelegationsPage {
  data: Delegation[];
  page: PageMeta;
}

/** Shared shape for the slice-7/11a approval endpoints (verify/return) and
 * the delegation write endpoints (create/revoke) — mirrors `SubmitJobResponse`
 * (ok:true carries the body, ok:false carries the Problem) rather than
 * throwing, because these calls have specific, screen-visible non-2xx
 * outcomes (403 step-up-required, 409 self-approval/invalid-transition, 422
 * validation) that a caller must branch on, not treat as transport failure. */
export interface JobActionResponse {
  status: number;
  ok: boolean;
  body?: Job;
  problem?: Problem;
}

export interface DelegationActionResponse {
  status: number;
  ok: boolean;
  body?: Delegation;
  problem?: Problem;
}

export interface AttachmentUploadResult {
  status: number;
  ok: boolean;
  attachment?: Attachment;
  problem?: Problem;
}

export interface AttachmentUploadOptions {
  /** REQUIRED by the contract (openapi `/jobs/{jobId}/attachments`). */
  idempotencyKey: string;
  /** Ties the photo to a specific item result, when known. */
  itemResultId?: string;
  /** Upload progress, 0..1 — real bytes-on-the-wire progress. */
  onProgress?: (fraction: number) => void;
}

/**
 * The transport seam (brief requirement: "keep the transport layer behind
 * an interface so real endpoints wire in without rewriting screens"). Every
 * screen and every offline module talks to THIS interface, never to `fetch`
 * directly. Two implementations exist:
 *
 *  - `HttpSyncTransport` (http-transport.ts): the real thing. It targets the
 *    exact paths and shapes in api/openapi.yaml. Several of those endpoints
 *    (`/sync/bootstrap`, `/sync/outbox`, `/jobs/**`) are not implemented on
 *    the server yet (api/ is slice 6/9/10 work on `main`, not built at the
 *    time of this branch) — calling them today will 404. That is expected;
 *    swapping in the real backend later requires no client change because
 *    this interface IS the contract.
 *  - `MockSyncTransport` (mock-transport.ts): an in-memory fake server used
 *    by unit tests and the Playwright offline suite, implementing the exact
 *    idempotency/conflict/quota semantics the real server is contracted to
 *    provide, so the outbox/sync-engine logic can be proven correct without
 *    depending on endpoints that don't exist yet.
 */
export interface SyncTransport {
  bootstrap(since?: string): Promise<SyncBootstrap>;
  drainOutbox(mutations: OutboxMutation[]): Promise<DrainOutboxResponse>;
  /** Non-negotiable #2: submit is a separate atomic call, never folded into
   * an outbox batch. This method exists precisely so no caller can
   * accidentally smuggle a submit into `drainOutbox`. */
  submitJob(jobId: string, idempotencyKey: string): Promise<SubmitJobResponse>;

  /** GET /jobs/{jobId} — the full record (frozen-revision checklist,
   * measurements, results, parts, attachments, approval history). Used by
   * the Record Review screen, which cannot rely on the offline job cache: a
   * verifier's device never bootstrapped the submitter's job. Online-only,
   * by design — reviewing/signing a record is not an offline workflow. */
  getJob(jobId: string): Promise<Job>;

  /** GET /queue — slice 11a. Records awaiting the caller's verification,
   * including any active delegator's queue (PR-076). */
  getQueue(params?: { limit?: number; cursor?: string }): Promise<QueuePage>;

  /** POST /jobs/{jobId}/verify — slice 7/11a. `request.drawnSignature` is
   * REQUIRED (`shared/src/job.ts` verifyJobRequestSchema). A 403 with
   * `problem.type` ending in `step-up-required` means the caller must
   * re-authenticate (see `auth/auth-client.ts#stepUp`) and retry with the
   * SAME signature. */
  verifyJob(
    jobId: string,
    request: VerifyJobRequest,
    idempotencyKey?: string,
  ): Promise<JobActionResponse>;

  /** POST /jobs/{jobId}/return — slice 7. `reason` must be >= 10 characters
   * (INV-13); the server re-validates and rejects 422 regardless. */
  returnJob(jobId: string, reason: string, idempotencyKey?: string): Promise<JobActionResponse>;

  /**
   * POST /jobs/{jobId}/attachments — slice 6 endpoint, first UI in slice 16
   * (D-2b). ONLINE-ONLY BY DESIGN (v1): attachments are never queued in the
   * offline outbox. Queueing multi-MB binary blobs into IndexedDB has real
   * quota consequences (PR-069 unresolved) — a full quota would start
   * refusing the CHECKLIST writes the outbox exists to protect. The screen
   * tells the technician to reconnect instead of pretending (see
   * RecordCapture's photo section, and the O-06/O-07 status notes in
   * docs/TEST_PLAN.md). Rejects (throws TransportError) when the network
   * dies mid-upload; resolves ok:false with the server's Problem on an
   * explicit rejection (magic-byte/size/count caps).
   */
  uploadAttachment(
    jobId: string,
    file: Blob,
    opts: AttachmentUploadOptions,
  ): Promise<AttachmentUploadResult>;

  /** GET /delegations — slice 11a. The caller's own delegation grants, plus
   * grants made TO them, either direction. */
  getDelegations(): Promise<DelegationsPage>;

  /** POST /delegations — slice 11a. */
  createDelegation(request: CreateDelegationRequest): Promise<DelegationActionResponse>;

  /** DELETE /delegations/{delegationId} — slice 11a. Idempotent: revoking an
   * already-revoked delegation returns it unchanged, not an error. */
  revokeDelegation(delegationId: string): Promise<DelegationActionResponse>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
