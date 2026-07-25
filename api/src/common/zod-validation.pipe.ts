import { type PipeTransform, UnprocessableEntityException } from '@nestjs/common';
import type { ZodType, ZodError } from 'zod';

/**
 * Maps a failed zod parse to the RFC 9457 `/errors/validation-failed` body
 * (API_SPECIFICATION.md §5.1). Extracted so `ZodValidationPipe` (the normal
 * per-endpoint request pipe) and the sync outbox dispatcher (`outbox-
 * dispatch.ts`, slice 9 — which validates each mutation's `body` manually,
 * outside Nest's pipe pipeline, since a batch fans out to several DTO shapes
 * picked at runtime by path) produce the IDENTICAL problem shape rather than
 * two hand-maintained copies drifting apart.
 */
export function zodErrorToValidationProblem(zodError: ZodError): {
  type: string;
  title: string;
  status: 422;
  detail: string;
  errors: { pointer: string; code: string; message: string }[];
} {
  return {
    type: '/errors/validation-failed',
    title: 'Validation failed',
    status: 422,
    detail: 'Request body failed validation.',
    errors: zodError.issues.map((issue) => ({
      pointer: `/${issue.path.join('/')}`,
      code: issue.code,
      message: issue.message,
    })),
  };
}

/**
 * Validates a request body against a shared Zod schema (ADR-002: the same
 * rule the client uses, not a reimplementation) and maps failures to RFC
 * 9457 `/errors/validation-failed` (API_SPECIFICATION.md §5.1).
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    throw new UnprocessableEntityException(zodErrorToValidationProblem(result.error as ZodError));
  }
}
