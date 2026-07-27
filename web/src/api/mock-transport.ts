import { TransportError } from './transport';
import type {
  SyncTransport,
  OutboxMutation,
  OutboxResult,
  DrainOutboxResponse,
  SubmitJobResponse,
  SyncBootstrap,
  Job,
  QueueEntry,
  QueuePage,
  Delegation,
  DelegationsPage,
  CreateDelegationRequest,
  VerifyJobRequest,
  JobActionResponse,
  DelegationActionResponse,
  Problem,
  Attachment,
  AttachmentUploadOptions,
  AttachmentUploadResult,
} from './transport';

/**
 * An in-memory fake server implementing the exact contract
 * `api/openapi.yaml` describes for `/sync/*` and `/jobs/{id}/submit`,
 * including the two behaviors that make the outbox provably safe:
 *
 *  - an idempotency store keyed by mutation id (PR-062): replaying an id
 *    returns the ORIGINAL stored result and does not re-run "business
 *    logic" a second time.
 *  - `dropResponseOnceFor` support: the mock commits the mutation (i.e. the
 *    idempotency store and the applied-count ARE updated) and only then
 *    throws, modelling "the server committed but the client never received
 *    the response" — the exact fault O-15 requires be injected.
 *
 * This is not a mock-testing-a-mock: it stands in for the one thing that is
 * out of the client's control (the network + a not-yet-built backend), at
 * the seam the brief requires (`SyncTransport`), so the outbox/sync-engine
 * code under test is real, production code.
 */
export class MockSyncTransport implements SyncTransport {
  /** id -> the result returned the first time; replayed verbatim after. */
  private readonly idempotencyStore = new Map<string, OutboxResult>();
  /** id -> number of times the "business logic" actually executed. Should
   * never exceed 1 for a given id no matter how many times it is replayed. */
  private readonly appliedCount = new Map<string, number>();
  private readonly conflictIds = new Set<string>();
  private readonly dropResponseOnce = new Set<string>();
  private readonly submitIdempotencyStore = new Map<string, SubmitJobResponse>();
  private readonly submitAppliedCount = new Map<string, number>();

  /** Slice 11b additions. This mock is a simpler stand-in than
   * `e2e/support/fake-server.ts` (which models the real two-stage/delegation
   * rules for the Playwright journeys) — it exists for Vitest-level module
   * tests that need SOME `SyncTransport` implementation and don't care about
   * approval-stage nuance, so `verifyJob` always finalizes in one call
   * rather than modelling `currentStageOrdinal`. */
  private readonly jobStore = new Map<string, Job>();
  private readonly queueEntries = new Map<string, QueueEntry>();
  private readonly delegationStore = new Map<string, Delegation>();
  private verifyOutcomeOverride: { status: number; problem?: Problem } | null = null;

  /** When true, every call throws before touching any state — models a
   * connection that never reaches the server at all (nothing commits). */
  networkDown = false;

  seedJob(job: Job): void {
    this.jobStore.set(job.id, job);
  }

  /** Models the job being reassigned away / removed server-side: `getJob`
   * then throws a TransportError carrying status 404, exactly as
   * `HttpSyncTransport.getJob` does for a non-OK response. */
  removeJob(jobId: string): void {
    this.jobStore.delete(jobId);
  }

  seedQueueEntry(entry: QueueEntry): void {
    this.queueEntries.set(entry.id, entry);
  }

  seedDelegation(delegation: Delegation): void {
    this.delegationStore.set(delegation.id, delegation);
  }

  /** The NEXT `verifyJob` call returns this outcome instead of succeeding —
   * used to exercise a caller's step-up-retry / error-handling branches
   * (e.g. `{ status: 403, problem: { type: '.../errors/step-up-required', ... } }`). */
  forceNextVerifyOutcome(status: number, problem?: Problem): void {
    this.verifyOutcomeOverride = { status, problem };
  }

  private bootstrapPayload: SyncBootstrap = {
    serverTime: new Date().toISOString(),
    user: { id: 'user-1', fullName: 'Test Technician', roles: ['MAINTAINER'] },
    jobs: [],
    syncToken: 'mock-token-0',
  };

  seedBootstrap(payload: Partial<SyncBootstrap>): void {
    this.bootstrapPayload = { ...this.bootstrapPayload, ...payload };
  }

  /** Marks these mutation ids to receive a 409 the first time they are seen. */
  forceConflict(...ids: string[]): void {
    for (const id of ids) this.conflictIds.add(id);
  }

  /** The NEXT time a batch containing this id is sent, the whole request
   * throws AFTER committing — simulating O-15/O-02's "kill the network
   * after the server already applied it" fault. */
  dropResponseOnceFor(...ids: string[]): void {
    for (const id of ids) this.dropResponseOnce.add(id);
  }

  timesApplied(id: string): number {
    return this.appliedCount.get(id) ?? 0;
  }

  timesSubmitApplied(idempotencyKey: string): number {
    return this.submitAppliedCount.get(idempotencyKey) ?? 0;
  }

  async bootstrap(_since?: string): Promise<SyncBootstrap> {
    if (this.networkDown) throw new TransportError('mock: network down');
    return this.bootstrapPayload;
  }

  async drainOutbox(mutations: OutboxMutation[]): Promise<DrainOutboxResponse> {
    if (this.networkDown) throw new TransportError('mock: network down');
    if (mutations.length > 200) {
      // Mirrors the server rejecting an over-cap batch (O-16). The client
      // must never construct one; this exists so a test can prove that.
      throw new TransportError('mock: batch exceeds 200 mutations (server would reject with 400)');
    }

    const results: OutboxResult[] = [];
    let mustDropResponse = false;

    for (const m of mutations) {
      const existing = this.idempotencyStore.get(m.id);
      if (existing) {
        // Replay: return the original result, run nothing again.
        results.push(existing);
        continue;
      }

      let result: OutboxResult;
      if (this.conflictIds.has(m.id)) {
        this.conflictIds.delete(m.id); // one-shot: resolves on the retry after the technician acts
        result = {
          id: m.id,
          status: 409,
          applied: false,
          problem: {
            type: 'https://form.bevorasg.com/errors/draft-conflict',
            title: 'Draft version conflict',
            status: 409,
          },
        };
      } else {
        this.appliedCount.set(m.id, (this.appliedCount.get(m.id) ?? 0) + 1);
        result = { id: m.id, status: 200, applied: true };
      }

      // Commit BEFORE deciding whether the response is lost — the fault is
      // "server applied it, client never found out", not "server never saw it".
      this.idempotencyStore.set(m.id, result);
      results.push(result);

      if (this.dropResponseOnce.has(m.id)) {
        this.dropResponseOnce.delete(m.id);
        mustDropResponse = true;
      }
    }

    if (mustDropResponse) {
      throw new TransportError('mock: response lost after server commit (O-15 fault injection)');
    }

    return { results, syncToken: `mock-token-${this.idempotencyStore.size}` };
  }

  async submitJob(jobId: string, idempotencyKey: string): Promise<SubmitJobResponse> {
    if (this.networkDown) throw new TransportError('mock: network down');
    const existing = this.submitIdempotencyStore.get(idempotencyKey);
    if (existing) return existing;

    this.submitAppliedCount.set(
      idempotencyKey,
      (this.submitAppliedCount.get(idempotencyKey) ?? 0) + 1,
    );
    const response: SubmitJobResponse = {
      status: 200,
      ok: true,
      body: { id: jobId, status: 'SUBMITTED' },
    };
    this.submitIdempotencyStore.set(idempotencyKey, response);
    return response;
  }

  async getJob(jobId: string): Promise<Job> {
    if (this.networkDown) throw new TransportError('mock: network down');
    const job = this.jobStore.get(jobId);
    if (!job) throw new TransportError(`mock: job ${jobId} not found`, undefined, 404);
    return job;
  }

  // ---- Slice 16 (D-2b): attachments, online-only ----
  private readonly attachmentStore = new Map<string, Attachment[]>();
  private readonly attachmentIdempotency = new Map<string, AttachmentUploadResult>();
  private attachmentSeq = 0;
  private uploadRejectionOverride: { status: number; problem?: Problem } | null = null;

  /** The NEXT upload is refused with this outcome (e.g. a 422 magic-byte
   * rejection) instead of being stored. */
  forceNextUploadRejection(status: number, problem?: Problem): void {
    this.uploadRejectionOverride = { status, problem };
  }

  attachmentsFor(jobId: string): Attachment[] {
    return this.attachmentStore.get(jobId) ?? [];
  }

  async uploadAttachment(
    jobId: string,
    file: Blob,
    opts: AttachmentUploadOptions,
  ): Promise<AttachmentUploadResult> {
    if (this.networkDown) throw new TransportError('mock: network down');
    const replay = this.attachmentIdempotency.get(opts.idempotencyKey);
    if (replay) return replay;

    opts.onProgress?.(0.5);
    if (this.uploadRejectionOverride) {
      const { status, problem } = this.uploadRejectionOverride;
      this.uploadRejectionOverride = null;
      const result: AttachmentUploadResult = { status, ok: false, problem };
      this.attachmentIdempotency.set(opts.idempotencyKey, result);
      return result;
    }
    opts.onProgress?.(1);
    const attachment: Attachment = {
      id: `att-${++this.attachmentSeq}`,
      itemResultId: opts.itemResultId ?? null,
      originalFilename: file instanceof File ? file.name : 'photo.jpg',
      contentType: 'image/jpeg',
      byteSize: file.size,
      uploadState: 'received',
    };
    const list = this.attachmentStore.get(jobId) ?? [];
    list.push(attachment);
    this.attachmentStore.set(jobId, list);
    const result: AttachmentUploadResult = { status: 201, ok: true, attachment };
    this.attachmentIdempotency.set(opts.idempotencyKey, result);
    return result;
  }

  async getQueue(): Promise<QueuePage> {
    if (this.networkDown) throw new TransportError('mock: network down');
    return {
      data: Array.from(this.queueEntries.values()),
      page: { hasMore: false, limit: 50, nextCursor: null },
    };
  }

  async verifyJob(jobId: string, request: VerifyJobRequest): Promise<JobActionResponse> {
    if (this.networkDown) throw new TransportError('mock: network down');
    if (!request.drawnSignature) {
      return {
        status: 422,
        ok: false,
        problem: {
          type: 'https://form.bevorasg.com/errors/attachment-rejected',
          title: 'drawnSignature is required (base64 PNG data-URL).',
          status: 422,
        },
      };
    }
    if (this.verifyOutcomeOverride) {
      const { status, problem } = this.verifyOutcomeOverride;
      this.verifyOutcomeOverride = null;
      return { status, ok: false, problem };
    }
    const job = this.jobStore.get(jobId);
    if (!job) {
      return {
        status: 404,
        ok: false,
        problem: { type: 'about:blank', title: 'Job not found', status: 404 },
      };
    }
    const updated: Job = { ...job, status: 'ARCHIVED' };
    this.jobStore.set(jobId, updated);
    this.queueEntries.delete(jobId);
    return { status: 200, ok: true, body: updated };
  }

  async returnJob(jobId: string, reason: string): Promise<JobActionResponse> {
    if (this.networkDown) throw new TransportError('mock: network down');
    if (reason.trim().length < 10) {
      return {
        status: 422,
        ok: false,
        problem: {
          type: 'about:blank',
          title: 'reason must be at least 10 characters (INV-13, PR-074).',
          status: 422,
        },
      };
    }
    const job = this.jobStore.get(jobId);
    if (!job) {
      return {
        status: 404,
        ok: false,
        problem: { type: 'about:blank', title: 'Job not found', status: 404 },
      };
    }
    const updated: Job = { ...job, status: 'IN_PROGRESS' };
    this.jobStore.set(jobId, updated);
    this.queueEntries.delete(jobId);
    return { status: 200, ok: true, body: updated };
  }

  async getDelegations(): Promise<DelegationsPage> {
    if (this.networkDown) throw new TransportError('mock: network down');
    return {
      data: Array.from(this.delegationStore.values()),
      page: { hasMore: false, limit: 50, nextCursor: null },
    };
  }

  async createDelegation(request: CreateDelegationRequest): Promise<DelegationActionResponse> {
    if (this.networkDown) throw new TransportError('mock: network down');
    const id = `deleg-${this.delegationStore.size + 1}`;
    const delegation: Delegation = {
      id,
      delegatorId: request.delegatorId,
      delegateId: request.delegateId,
      validFrom: request.validFrom,
      validTo: request.validTo,
      reason: request.reason ?? null,
      createdBy: request.delegatorId,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.delegationStore.set(id, delegation);
    return { status: 201, ok: true, body: delegation };
  }

  async revokeDelegation(delegationId: string): Promise<DelegationActionResponse> {
    if (this.networkDown) throw new TransportError('mock: network down');
    const delegation = this.delegationStore.get(delegationId);
    if (!delegation) {
      return {
        status: 404,
        ok: false,
        problem: { type: 'about:blank', title: 'Delegation not found', status: 404 },
      };
    }
    const revoked: Delegation = delegation.revokedAt
      ? delegation
      : { ...delegation, revokedAt: new Date().toISOString() };
    this.delegationStore.set(delegationId, revoked);
    return { status: 200, ok: true, body: revoked };
  }
}
