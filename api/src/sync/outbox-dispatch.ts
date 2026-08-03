import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import type { ZodError, ZodType } from 'zod';
import { zodErrorToValidationProblem } from '../common/zod-validation.pipe';

/**
 * The outbox-reachable mutation surface (API_SPECIFICATION.md §11.2, slice
 * 6's `JobsController`): PUT item/measurement result, POST a part, PUT a
 * client-keyed part upsert (slice 30, Task 4), PUT the title's machine number
 * (slice 31-TITLEBLANK). Anything else — `/jobs/{id}/submit` (PR-API-26),
 * `/jobs/{id}/attachments` (PR-API-27), DELETE anything (non-negotiable #7),
 * or any unrecognised path — is NOT in this union and must be rejected
 * per-mutation by the caller (`sync-outbox.service.ts`), never silently
 * applied.
 */
export type OutboxRoute =
  | { kind: 'item'; jobId: string; templateItemId: string }
  | { kind: 'measurement'; jobId: string; templateMeasurementId: string }
  | { kind: 'part'; jobId: string }
  | { kind: 'part-upsert'; jobId: string; partId: string }
  | { kind: 'title-machine-number'; jobId: string };

const ITEM_PATH = /^\/jobs\/([^/]+)\/items\/([^/]+)$/;
const MEASUREMENT_PATH = /^\/jobs\/([^/]+)\/measurements\/([^/]+)$/;
const PARTS_PATH = /^\/jobs\/([^/]+)\/parts$/;
const PARTS_UPSERT_PATH = /^\/jobs\/([^/]+)\/parts\/([^/]+)$/;
const TITLE_MACHINE_NUMBER_PATH = /^\/jobs\/([^/]+)\/title-machine-number$/;

/**
 * Pure path/method matcher — deliberately dependency-free (no Nest, no DB)
 * so it is trivially unit-testable (`outbox-dispatch.spec.ts`) and mirrors
 * `contract-checks.ts`'s "pure comparison functions" pattern. This is the
 * SAME set of paths `jobs.controller.ts` wires — see that file's `@Put`/
 * `@Post` decorators — kept in sync by inspection, not by a shared table,
 * because the controller shapes (Nest decorators) and this outbox allowlist
 * (plain strings, no Nest dependency) are different mechanisms serving
 * different callers (HTTP router vs. in-process batch dispatch).
 */
export function matchOutboxRoute(method: string, path: string): OutboxRoute | null {
  if (method === 'PUT') {
    const item = ITEM_PATH.exec(path);
    if (item) return { kind: 'item', jobId: item[1], templateItemId: item[2] };

    const measurement = MEASUREMENT_PATH.exec(path);
    if (measurement) {
      return { kind: 'measurement', jobId: measurement[1], templateMeasurementId: measurement[2] };
    }

    // Tested BEFORE the two-segment part-upsert pattern purely for
    // readability — the two cannot collide, since `title-machine-number` is a
    // single segment where `parts/{partId}` is two.
    const titleMachineNumber = TITLE_MACHINE_NUMBER_PATH.exec(path);
    if (titleMachineNumber) {
      return { kind: 'title-machine-number', jobId: titleMachineNumber[1] };
    }

    const partUpsert = PARTS_UPSERT_PATH.exec(path);
    if (partUpsert) return { kind: 'part-upsert', jobId: partUpsert[1], partId: partUpsert[2] };

    return null;
  }

  if (method === 'POST') {
    const parts = PARTS_PATH.exec(path);
    if (parts) return { kind: 'part', jobId: parts[1] };
    return null;
  }

  return null;
}

/** Validates an outbox mutation's `body` against the DTO schema its matched route expects. */
export function parseMutationBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new UnprocessableEntityException(zodErrorToValidationProblem(result.error as ZodError));
  }
  return result.data;
}

/**
 * Converts whatever a dispatched slice-6 service method threw (a domain
 * `HttpException` from `domain-problems.ts` — not-found, draft-conflict,
 * idempotency-mismatch, forbidden, etc.) into `{status, problem}` for that
 * mutation's `OutboxResult`. An error that is NOT an `HttpException` is a
 * programming/infra fault, not a domain rejection — it is rethrown so it
 * fails the request loudly (500) instead of being silently folded into a
 * per-mutation result (PR-API-24 is about domain failures not blocking the
 * batch, not about swallowing bugs).
 */
export function toOutboxProblem(error: unknown): {
  status: number;
  problem: Record<string, unknown>;
} {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const status = error.getStatus();
    if (typeof response === 'object' && response !== null) {
      return { status, problem: response as Record<string, unknown> };
    }
    return {
      status,
      problem: {
        type: '/errors/validation-failed',
        title: 'Error',
        status,
        detail: String(response),
      },
    };
  }
  throw error;
}
