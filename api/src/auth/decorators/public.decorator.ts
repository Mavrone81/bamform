import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a handler as reachable without authentication. PR-SEC-05: auth is
 * deny-by-default — a handler without an explicit guard is unreachable, not
 * open, so this is an opt-IN allowlist, not an opt-out. Matches
 * `api/openapi.yaml`'s `security: []` overrides: `/health`, `/health/ready`,
 * `/.well-known/jwks.json`, `/auth/login`, `/auth/refresh`.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
