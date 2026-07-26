import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Liveness probe — no database round-trip. `dist/healthcheck.js`
 * (`api/src/healthcheck.ts`, used by docker-compose.yml's `bamform-api`
 * healthcheck) probes THIS endpoint over loopback. That script was promised
 * here from slice 1 but only actually written on 2026-07-26, so until then
 * every container health probe failed with `Cannot find module` and
 * `bamform-api` reported `unhealthy` throughout its production life while
 * serving traffic normally. `scripts/ci/assert-compose-runtime-contract.mjs`
 * now fails CI if a healthcheck command names a script that does not exist.
 *
 * `@Public()` added in slice 2: the new global `JwtAuthGuard` (deny-by-
 * default, PR-SEC-05) would otherwise lock out this pre-existing probe.
 */
@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
