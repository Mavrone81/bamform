import Redis from 'ioredis';

/**
 * Auth integration tests exercise real Redis (ADR-006: rate limiting, jti
 * denylist). Separate connection from the app's own `RedisModule` client so
 * tests can flush state between cases without reaching into DI internals —
 * mirrors `helpers/db.ts`'s separate admin/app pools for the same reason.
 */
export const testRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

export async function resetRedis(): Promise<void> {
  await testRedis.flushdb();
}

export async function closeRedis(): Promise<void> {
  await testRedis.quit();
}
