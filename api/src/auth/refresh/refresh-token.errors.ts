import { UnauthorizedException } from '@nestjs/common';

function unauthenticatedProblem(detail: string) {
  return new UnauthorizedException({
    type: '/errors/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    detail,
  });
}

/** Presented refresh token does not correspond to any issued token. */
export function invalidRefreshTokenError(): UnauthorizedException {
  return unauthenticatedProblem('Refresh token is invalid, expired or already used.');
}

/**
 * PR-084: presenting an already-rotated (single-use) refresh token. The
 * caller has already revoked the whole family and written the security
 * audit event by the time this is thrown.
 */
export function refreshReuseDetectedError(): UnauthorizedException {
  return unauthenticatedProblem('Refresh token reuse detected — session revoked.');
}
