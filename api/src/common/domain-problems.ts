import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

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
