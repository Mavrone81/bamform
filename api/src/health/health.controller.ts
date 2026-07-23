import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe only for slice 1 — no database round-trip yet. The full
 * `dist/healthcheck.js` (used by docker-compose.yml's `bamform-api`
 * healthcheck) is built out with the rest of the runtime in later slices.
 */
@Controller()
export class HealthController {
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
