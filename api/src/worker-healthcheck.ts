import Redis from 'ioredis';

/**
 * `dist/worker-healthcheck.js` — docker-compose.yml's `bamform-worker`
 * `healthcheck.test`. Deliberately a standalone script (no NestJS bootstrap,
 * no Prisma) — mirrors the lightness the api's own `dist/healthcheck.js`
 * would have, per `docs/ENVIRONMENT_REQUIREMENTS.md` line for
 * `bamform-worker`: "Queue heartbeat key in Redis" is the documented signal.
 * `worker.ts` refreshes `bf:scheduler:heartbeat` every tick (every 20s)
 * regardless of `SCHEDULER_ENABLED`, so a missing or stale key means the
 * process is wedged or dead, not merely that the cron hasn't fired yet.
 *
 * Exit 0 = healthy, exit 1 = unhealthy, matching Docker's `HEALTHCHECK`
 * contract.
 */

const HEARTBEAT_KEY = 'bf:scheduler:heartbeat';
// Generous relative to the 20s tick interval and 300s heartbeat TTL —
// this only needs to catch "the process stopped ticking", not race the
// tick cadence itself.
const MAX_HEARTBEAT_AGE_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });

  try {
    await redis.connect();
    const value = await redis.get(HEARTBEAT_KEY);
    if (!value) {
      process.exitCode = 1;
      return;
    }

    const age = Date.now() - new Date(value).getTime();
    process.exitCode = Number.isNaN(age) || age > MAX_HEARTBEAT_AGE_MS ? 1 : 0;
  } catch {
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}

void main();
