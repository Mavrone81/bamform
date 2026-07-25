import { TransportError } from './transport';
import type {
  SyncTransport,
  OutboxMutation,
  OutboxResult,
  DrainOutboxResponse,
  SubmitJobResponse,
  SyncBootstrap,
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

  /** When true, every call throws before touching any state — models a
   * connection that never reaches the server at all (nothing commits). */
  networkDown = false;

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
}
