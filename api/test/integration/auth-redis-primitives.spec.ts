import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { LoginRateLimiterService } from '../../src/auth/redis/login-rate-limiter.service';
import { TokenDenylistService } from '../../src/auth/redis/token-denylist.service';
import { closeRedis, resetRedis } from './helpers/redis';

/**
 * PR-088 (jti denylist) / PR-092 (login rate limiting) against a REAL Redis
 * instance (ADR-006), not a mock — these primitives are pure Redis
 * key/TTL semantics, worth proving directly rather than only indirectly
 * through the HTTP-level auth specs.
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
  });

  describe('LoginRateLimiterService (PR-092, API_SPEC §9: 10/min per IP)', () => {
    it('allows requests under the configured limit', async () => {
      const config = new ConfigService({ RATE_LIMIT_LOGIN_PER_MIN: '3' });
      const service = new LoginRateLimiterService(redis, config);

      const results = await Promise.all([
        service.checkAndIncrement('1.2.3.4'),
        service.checkAndIncrement('1.2.3.4'),
        service.checkAndIncrement('1.2.3.4'),
      ]);
      expect(results.every((r) => r.limited === false)).toBe(true);
    });

    it('rejects the request that exceeds the limit, with a positive Retry-After', async () => {
      const config = new ConfigService({ RATE_LIMIT_LOGIN_PER_MIN: '2' });
      const service = new LoginRateLimiterService(redis, config);

      await service.checkAndIncrement('5.6.7.8');
      await service.checkAndIncrement('5.6.7.8');
      const third = await service.checkAndIncrement('5.6.7.8');

      expect(third.limited).toBe(true);
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('tracks distinct IPs independently', async () => {
      const config = new ConfigService({ RATE_LIMIT_LOGIN_PER_MIN: '1' });
      const service = new LoginRateLimiterService(redis, config);

      const first = await service.checkAndIncrement('9.9.9.9');
      const second = await service.checkAndIncrement('10.10.10.10');

      expect(first.limited).toBe(false);
      expect(second.limited).toBe(false);
    });
  });
});
