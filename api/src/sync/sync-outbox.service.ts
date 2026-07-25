import { Injectable } from '@nestjs/common';
import {
  itemResultInputSchema,
  measurementResultInputSchema,
  partUsedInputSchema,
  type OutboxMutation,
  type OutboxResponse,
  type OutboxResult,
} from '@bamform/shared';
import type { ActorMeta } from '../common/actor-meta';
import { outboxMutationNotAllowedProblem } from '../common/domain-problems';
import { PartsService } from '../jobs/parts.service';
import { ResultsService } from '../jobs/results.service';
import { matchOutboxRoute, parseMutationBody, toOutboxProblem } from './outbox-dispatch';
import { encodeSyncToken } from './sync-cursor';

/**
 * `POST /sync/outbox` (API_SPECIFICATION.md §11.2, PR-API-24/25, PR-062,
 * PR-082). Dispatches each mutation to the SAME slice-6 service methods
 * `jobs.controller.ts` calls for the equivalent direct HTTP endpoint —
 * `ResultsService#recordItemResult`/`#recordMeasurementResult`,
 * `PartsService#recordPart` (`api/src/jobs/results.service.ts`,
 * `parts.service.ts`) — IN-PROCESS, not by the api HTTP-calling itself.
 *
 * Idempotency reuse point (PR-API-25): `mutation.id` is passed as
 * `idempotencyKey` straight into those methods' existing
 * `IdempotencyService.checkReplay`/`recordWithin` calls
 * (`results.service.ts` lines 61-72/122-131, 147-158/227-236;
 * `parts.service.ts` lines 40-46/78-89) — replaying the SAME mutation id +
 * body returns the cached response transparently (I-INV-16); the SAME id
 * with a DIFFERENT body throws `idempotencyMismatchProblem()` (422),
 * caught below and surfaced as that mutation's `problem` (I-INV-17). No
 * second idempotency mechanism is built here.
 *
 * Sequencing + transaction shape (PR-API-24/PR-082 — resolved reading, see
 * slice-9-report.md): mutations are sorted by `sequence` ascending and
 * applied ONE AT A TIME, each via its dispatched service method's OWN
 * `prisma.$transaction` (already established by slice 6 — see
 * `results.service.ts`/`parts.service.ts`: each call commits its
 * result/part row + `job` status/draftVersion bump + `audit_event` in ONE
 * transaction). That transaction's scope is inherently "per job" (a
 * mutation only ever touches one job), which satisfies PR-082's "a
 * transaction per job" WITHOUT grouping several mutations for the same job
 * into one shared transaction — grouping them would directly contradict
 * "one failure does not block the batch" (PR-API-24), since a later
 * mutation's failure would then roll back an earlier, already-succeeded
 * one in the same job. Per-mutation transactions is the only reading
 * consistent with BOTH sentences of PR-082 at once.
 */
@Injectable()
export class SyncOutboxService {
  constructor(
    private readonly results: ResultsService,
    private readonly parts: PartsService,
  ) {}

  async drain(
    mutations: OutboxMutation[],
    actor: ActorMeta,
    roles: string[],
  ): Promise<OutboxResponse> {
    const ordered = [...mutations].sort((a, b) => a.sequence - b.sequence);

    const results: OutboxResult[] = [];
    for (const mutation of ordered) {
      // Sequential, not `Promise.all` — sequence order is meaningful when
      // mutations target the SAME job (e.g. two updates to one item), and
      // out-of-order concurrent application would race that ordering.
      results.push(await this.applyOne(mutation, actor, roles));
    }

    return { results, syncToken: encodeSyncToken(new Date()) };
  }

  private async applyOne(
    mutation: OutboxMutation,
    actor: ActorMeta,
    roles: string[],
  ): Promise<OutboxResult> {
    try {
      const route = matchOutboxRoute(mutation.method, mutation.path);
      if (!route) {
        throw outboxMutationNotAllowedProblem(mutation.method, mutation.path);
      }

      const ifMatch = mutation.ifMatch != null ? String(mutation.ifMatch) : undefined;

      switch (route.kind) {
        case 'item': {
          const dto = parseMutationBody(itemResultInputSchema, mutation.body);
          await this.results.recordItemResult(
            route.jobId,
            route.templateItemId,
            dto,
            { idempotencyKey: mutation.id, ifMatch },
            actor,
            roles,
          );
          return { id: mutation.id, status: 200, applied: true };
        }
        case 'measurement': {
          const dto = parseMutationBody(measurementResultInputSchema, mutation.body);
          await this.results.recordMeasurementResult(
            route.jobId,
            route.templateMeasurementId,
            dto,
            { idempotencyKey: mutation.id, ifMatch },
            actor,
            roles,
          );
          return { id: mutation.id, status: 200, applied: true };
        }
        case 'part': {
          const dto = parseMutationBody(partUsedInputSchema, mutation.body);
          await this.parts.recordPart(route.jobId, dto, mutation.id, actor, roles);
          return { id: mutation.id, status: 201, applied: true };
        }
      }
    } catch (error) {
      const { status, problem } = toOutboxProblem(error);
      return {
        id: mutation.id,
        status,
        applied: false,
        problem: problem as OutboxResult['problem'],
      };
    }
  }
}
