import { request } from 'node:http';

/**
 * `dist/healthcheck.js` — docker-compose.yml's `bamform-api`
 * `healthcheck.test`. The compose file has referenced this path since slice 1
 * but the file was never written, so `node dist/healthcheck.js` exited 1 with
 * `Cannot find module` on every probe and `bamform-api` has reported
 * `unhealthy` for its entire production life (found 2026-07-26). The api
 * itself was serving fine throughout — the probe, not the service, was broken.
 *
 * Deliberately a standalone script with no NestJS bootstrap and no Prisma,
 * matching `worker-healthcheck.ts`: a healthcheck that boots the whole
 * application would report the container unhealthy purely because a cold
 * start exceeded the 5 s timeout.
 *
 * The api's liveness endpoint is `GET /api/v1/healthz` (`HealthController`,
 * `@Public()`), served on port 3000 inside the container — `main.ts` hardcodes
 * `app.listen(3000)`; `${API_PORT}` is only the host-side mapping, so the
 * probe must not read it.
 *
 * Exit 0 = healthy, exit 1 = unhealthy, matching Docker's `HEALTHCHECK`
 * contract.
 */

const PORT = 3000;
const PATH = '/api/v1/healthz';
// Comfortably inside compose's 5s healthcheck timeout, so a hung socket
// surfaces as our own clean exit 1 rather than Docker killing the probe.
const TIMEOUT_MS = 3000;

function main(): void {
  const req = request(
    { host: '127.0.0.1', port: PORT, path: PATH, method: 'GET', timeout: TIMEOUT_MS },
    (res) => {
      // Drain: leaving the socket unread keeps the event loop alive and the
      // process would sit until Docker's timeout instead of exiting promptly.
      res.resume();
      process.exitCode = res.statusCode === 200 ? 0 : 1;
    },
  );

  req.on('timeout', () => {
    process.exitCode = 1;
    req.destroy();
  });
  req.on('error', () => {
    process.exitCode = 1;
  });

  req.end();
}

main();
