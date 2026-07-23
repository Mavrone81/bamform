import { type PipeTransform, UnprocessableEntityException } from '@nestjs/common';
import type { ZodType, ZodError } from 'zod';

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

    const zodError = result.error as ZodError;
    throw new UnprocessableEntityException({
      type: '/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'Request body failed validation.',
      errors: zodError.issues.map((issue) => ({
        pointer: `/${issue.path.join('/')}`,
        code: issue.code,
        message: issue.message,
      })),
    });
  }
}
