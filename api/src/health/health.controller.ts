import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Liveness probe only for slice 1 — no database round-trip yet. The full
 * `dist/healthcheck.js` (used by docker-compose.yml's `bamform-api`
 * healthcheck) is built out with the rest of the runtime in later slices.
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
