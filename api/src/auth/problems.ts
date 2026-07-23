import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

/**
 * RFC 9457 Problem Details shapes for the auth error cases API_SPECIFICATION.md
 * §5.1's catalogue actually names: `/errors/unauthenticated` (401) and
 * `/errors/rate-limited` (429, `Retry-After`). The catalogue has no distinct
 * `type` for "account locked" — PR-092 pairs lockout with rate limiting
 * ("rate-limited with exponential backoff and account lockout"), and
 * `/errors/rate-limited` is the only 429 entry, so a locked account is
 * reported the same way a rate-limited IP is: 429 + `Retry-After`.
 */

export function invalidCredentialsProblem(): UnauthorizedException {
  return new UnauthorizedException({
    type: '/errors/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    detail: 'Email or password is incorrect.',
  });
}

export class RateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number, detail: string) {
    super(
      {
        type: '/errors/rate-limited',
        title: 'Rate limited',
        status: HttpStatus.TOO_MANY_REQUESTS,
        detail,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }

  readonly retryAfterSeconds: number;
}
