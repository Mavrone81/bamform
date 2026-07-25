import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { OutstandingItem } from '@bamform/shared';

/**
 * RFC 9457 Problem Details factories for the cross-domain error types
 * API_SPECIFICATION.md §5.1's catalogue names that aren't already covered by
 * `auth/problems.ts` (which is auth-specific) or `ZodValidationPipe`
 * (`/errors/validation-failed`). Shared across assets/areas/asset-types/
 * templates so every module raises the SAME shape for the SAME case,
 * per BUILD_HANDOFF §6 traceability discipline.
 */

export function notFoundProblem(entity: string, id: string): NotFoundException {
  return new NotFoundException({
    type: '/errors/not-found',
    title: 'Not found',
    status: 404,
    detail: `${entity} ${id} was not found.`,
  });
}

/** PR-API-10: entity exists but is outside the caller's area scope. */
export function outOfScopeProblem(entity: string): ForbiddenException {
  return new ForbiddenException({
    type: '/errors/out-of-scope',
    title: 'Out of scope',
    status: 403,
    detail: `${entity} exists but is outside your area scope.`,
  });
}

/** INV-03/PR-047: actor is both the revision's author and its would-be approver. */
export function selfApprovalProblem(detail: string): ConflictException {
  return new ConflictException({
    type: '/errors/self-approval',
    title: 'Self-approval is not permitted',
    status: 409,
    detail,
  });
}

/** State machine rejects the requested transition (e.g. approve a non-pending revision). */
export function invalidTransitionProblem(detail: string): ConflictException {
  return new ConflictException({
    type: '/errors/invalid-transition',
    title: 'Invalid transition',
    status: 409,
    detail,
  });
}

/** Duplicate unique field (asset code, document number, area/asset-type code, ...). */
export function conflictProblem(detail: string): ConflictException {
  return new ConflictException({
    type: '/errors/validation-failed',
    title: 'Conflict',
    status: 409,
    detail,
  });
}

/** INV-02: would create a gap in `template_revision.sequence_ordinal`. */
export function revisionSequenceGapProblem(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/revision-sequence-gap',
    title: 'Revision sequence gap',
    status: 422,
    detail: 'Creating this revision would break the contiguous sequence for this template.',
  });
}

/** INV-04: `lowerLimit > upperLimit`. */
export function specLimitsInvertedProblem(pointer: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/spec-limits-inverted',
    title: 'Specification limits inverted',
    status: 422,
    detail: 'lowerLimit must be less than or equal to upperLimit.',
    errors: [{ pointer, code: 'SPEC_LIMITS_INVERTED', message: 'lowerLimit > upperLimit' }],
  });
}

/** Generic domain-level validation failure not already caught by ZodValidationPipe. */
export function validationFailedProblem(detail: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/validation-failed',
    title: 'Validation failed',
    status: 422,
    detail,
  });
}

/** PR-API-11/§4.1: authenticated but not permitted (role- or ownership-based, not a route-level @Roles() denial). */
export function forbiddenProblem(detail: string): ForbiddenException {
  return new ForbiddenException({
    type: '/errors/forbidden',
    title: 'Forbidden',
    status: 403,
    detail,
  });
}

/** PR-API-16/DBD §6.23: same `Idempotency-Key` replayed with a DIFFERENT request body — a client defect, not a retry. */
export function idempotencyMismatchProblem(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/idempotency-mismatch',
    title: 'Idempotency key reused with a different request',
    status: 422,
    detail: 'This Idempotency-Key was already used for a different request body.',
  });
}

/** PR-API-16: `Idempotency-Key` header absent on an endpoint reachable from the offline outbox. */
export function idempotencyKeyRequiredProblem(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/validation-failed',
    title: 'Validation failed',
    status: 422,
    detail: 'Idempotency-Key header is required on this endpoint.',
    errors: [{ pointer: '/', code: 'REQUIRED', message: 'Idempotency-Key header is required' }],
  });
}

/** PR-045/PR-API-13: `IN_PROGRESS -> SUBMITTED` rejected — mandatory items outstanding. Lists them, not just a count. */
export function incompleteRecordProblem(
  outstanding: OutstandingItem[],
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/incomplete-record',
    title: 'Record is incomplete',
    status: 422,
    detail: `${outstanding.length} mandatory item${outstanding.length === 1 ? '' : 's'} ${outstanding.length === 1 ? 'has' : 'have'} no recorded status.`,
    errors: outstanding.map((item) => ({
      pointer: `/items/${item.itemNo}`,
      code: 'REQUIRED',
      message: `Item ${item.itemNo} has no recorded status`,
    })),
  });
}

/** INV-09/PR-041: attempted mutation against an ARCHIVED (or otherwise terminal-immutable) job. */
export function recordImmutableProblem(): ConflictException {
  return new ConflictException({
    type: '/errors/record-immutable',
    title: 'Record is immutable',
    status: 409,
    detail: 'This record is archived and can no longer be modified.',
  });
}

/** PR-API-18/PR-064: the job's `draftVersion` no longer matches the client's `If-Match`. */
export function draftConflictProblem(currentDraftVersion: number): ConflictException {
  return new ConflictException({
    type: '/errors/draft-conflict',
    title: 'Draft version conflict',
    status: 409,
    detail: 'The job draft has changed since you last read it.',
    errors: [
      {
        pointer: '/draftVersion',
        code: 'DRAFT_CONFLICT',
        message: `Current draftVersion is ${currentDraftVersion}`,
      },
    ],
  });
}

/** SECURITY_ARCHITECTURE.md §10.1: attachment failed type/size/magic-byte validation (S-30, S-32). */
export function attachmentRejectedProblem(detail: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: '/errors/attachment-rejected',
    title: 'Attachment rejected',
    status: 422,
    detail,
  });
}
