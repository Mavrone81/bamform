import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * Generic fixed-window Redis rate limiter (INCR+EXPIRE, ADR-006: Redis for
 * rate limiting), keyed by an arbitrary `scope` + `id` pair so every
 * per-minute limit in API_SPECIFICATION.md §9 shares one mechanism rather
 * than each caller re-implementing its own counter:
 *
 * - `POST /auth/login`: scope `'login'`, id = source IP, limit
 *   `RATE_LIMIT_LOGIN_PER_MIN` (PR-092).
 * - `POST /auth/step-up`: scope `'step-up'`, id = `user.sub`, limit
 *   `RATE_LIMIT_STEP_UP_PER_MIN` (PR-091/PR-092 — closes the brute-force
 *   hole where a stolen access token could otherwise guess the password via
 *   step-up with no limiter in front of it at all).
 *
 * Callers own their own config lookups (limit is passed in) so this service
 * has no opinion on which endpoint it is protecting.
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async checkAndIncrement(
    scope: string,
    id: string,
    limitPerMinute: number,
  ): Promise<RateLimitResult> {
    const key = `bamform:auth:ratelimit:${scope}:${id}`;
    const windowSeconds = 60;

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    if (count > limitPerMinute) {
      const ttl = await this.redis.ttl(key);
      return { limited: true, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    }
    return { limited: false, retryAfterSeconds: 0 };
  }
}
