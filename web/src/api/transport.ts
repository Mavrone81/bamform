import type { components } from './generated/openapi-types';

export type OutboxMutation = components['schemas']['OutboxMutation'];
export type OutboxResult = components['schemas']['OutboxResult'];
export type SyncBootstrap = components['schemas']['SyncBootstrap'];
export type Problem = components['schemas']['Problem'];

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
