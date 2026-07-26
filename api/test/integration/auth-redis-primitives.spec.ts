import Redis from 'ioredis';
import { RateLimiterService } from '../../src/auth/redis/rate-limiter.service';
import { TokenDenylistService } from '../../src/auth/redis/token-denylist.service';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * PR-088 (jti denylist) / PR-092 (login + step-up rate limiting) against a
 * REAL Redis instance (ADR-006), not a mock — these primitives are pure
 * Redis key/TTL semantics, worth proving directly rather than only
 * indirectly through the HTTP-level auth specs.
 */
describe('Redis-backed auth primitives (real Redis, ADR-006)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  });

  afterAll(async () => {
    await redis.quit();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetRedis();
  });

  describe('TokenDenylistService (PR-088)', () => {
    it('a denylisted jti is reported as denylisted', async () => {
      const service = new TokenDenylistService(redis);
      await service.denylist('jti-123', 900);

      await expect(service.isDenylisted('jti-123')).resolves.toBe(true);
    });

    it('a jti never denylisted is not reported as denylisted', async () => {
      const service = new TokenDenylistService(redis);
      await expect(service.isDenylisted('never-seen')).resolves.toBe(false);
    });

    it('sets a TTL equal to the remaining token lifetime, not longer', async () => {
      const service = new TokenDenylistService(redis);
      await service.denylist('jti-ttl', 60);

      const ttl = await redis.ttl('bamform:auth:denylist:jti-ttl');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it('does not write an entry for an already-expired token', async () => {
      const service = new TokenDenylistService(redis);
      await service.denylist('jti-expired', -5);

      await expect(service.isDenylisted('jti-expired')).resolves.toBe(false);
    });

    // Slice 13-MFA fix-delta re-review, finding FD-1. `claim()` is what makes
    // the MFA challenge token single-use under concurrency, but NOTHING pinned
    // it: reverting it to isDenylisted()+denylist() leaves every end-to-end
    // test green, because the in-process Postgres pool and the app_user row
    // lock serialise those requests long before the claim is reached. The
    // race is real in a multi-worker deployment; the test that would catch a
    // regression has to exercise the primitive directly.
    it('claim() burns a jti for exactly ONE caller — the single-use guarantee (FD-1)', async () => {
      const service = new TokenDenylistService(redis);

      await expect(service.claim('jti-claim-once', 900)).resolves.toBe(true);
      await expect(service.claim('jti-claim-once', 900)).resolves.toBe(false);
      await expect(service.isDenylisted('jti-claim-once')).resolves.toBe(true);
    });

    it('claim() is atomic under concurrency — exactly one of N racers wins (FD-1)', async () => {
      const service = new TokenDenylistService(redis);

      // Bypasses the app-level serialisation that hides this at the HTTP
      // layer: these land on Redis genuinely concurrently.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => service.claim('jti-claim-race', 900)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('claim() writes a bounded TTL even when the remaining lifetime rounds to zero', async () => {
      const service = new TokenDenylistService(redis);

      // Unlike denylist(), claim() must never no-op: writing nothing would
      // hand `true` to every concurrent caller and silently restore the race.
      await expect(service.claim('jti-claim-ttl0', 0)).resolves.toBe(true);
      await expect(service.claim('jti-claim-ttl0', 0)).resolves.toBe(false);
      expect(await redis.ttl('bamform:auth:denylist:jti-claim-ttl0')).toBeGreaterThan(0);
    });
  });

  describe('RateLimiterService — login scope (PR-092, API_SPEC §9: 10/min per IP)', () => {
    it('allows requests under the configured limit', async () => {
      const service = new RateLimiterService(redis);

      const results = await Promise.all([
        service.checkAndIncrement('login', '1.2.3.4', 3),
        service.checkAndIncrement('login', '1.2.3.4', 3),
        service.checkAndIncrement('login', '1.2.3.4', 3),
      ]);
      expect(results.every((r) => r.limited === false)).toBe(true);
    });

    it('rejects the request that exceeds the limit, with a positive Retry-After', async () => {
      const service = new RateLimiterService(redis);

      await service.checkAndIncrement('login', '5.6.7.8', 2);
      await service.checkAndIncrement('login', '5.6.7.8', 2);
      const third = await service.checkAndIncrement('login', '5.6.7.8', 2);

      expect(third.limited).toBe(true);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('tracks distinct IPs independently', async () => {
      const service = new RateLimiterService(redis);

      const first = await service.checkAndIncrement('login', '9.9.9.9', 1);
      const second = await service.checkAndIncrement('login', '10.10.10.10', 1);

      expect(first.limited).toBe(false);
      expect(second.limited).toBe(false);
    });
  });

  describe('RateLimiterService — step-up scope (PR-091/PR-092, API_SPEC §9: 10/min per user)', () => {
    it('allows requests under the configured limit', async () => {
      const service = new RateLimiterService(redis);

      const results = await Promise.all([
        service.checkAndIncrement('step-up', 'user-a', 3),
        service.checkAndIncrement('step-up', 'user-a', 3),
        service.checkAndIncrement('step-up', 'user-a', 3),
      ]);
      expect(results.every((r) => r.limited === false)).toBe(true);
    });

    it('rejects the request that exceeds the limit, with a positive Retry-After', async () => {
      const service = new RateLimiterService(redis);

      await service.checkAndIncrement('step-up', 'user-b', 2);
      await service.checkAndIncrement('step-up', 'user-b', 2);
      const third = await service.checkAndIncrement('step-up', 'user-b', 2);

      expect(third.limited).toBe(true);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('tracks distinct users independently, and independently of the login scope', async () => {
      const service = new RateLimiterService(redis);

      // Exhaust user-c's step-up limit.
      await service.checkAndIncrement('step-up', 'user-c', 1);
      const userC = await service.checkAndIncrement('step-up', 'user-c', 1);

      // A different user's step-up attempts are unaffected...
      const userD = await service.checkAndIncrement('step-up', 'user-d', 1);
      // ...and a login attempt keyed by the SAME id (user-c as a literal
      // string) does not share the counter — scope is part of the key.
      const loginSameId = await service.checkAndIncrement('login', 'user-c', 1);

      expect(userC.limited).toBe(true);
      expect(userD.limited).toBe(false);
      expect(loginSameId.limited).toBe(false);
    });
  });
});
