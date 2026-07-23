import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * PR-092 / API_SPECIFICATION.md §9: `POST /auth/login` is rate-limited to
 * `RATE_LIMIT_LOGIN_PER_MIN` requests per minute, per source IP. Fixed
 * 60-second window via Redis INCR+EXPIRE (ADR-006: Redis for rate limiting).
 */
@Injectable()
export class LoginRateLimiterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  private get limit(): number {
    return Number(this.config.get('RATE_LIMIT_LOGIN_PER_MIN') ?? 10);
  }

  async checkAndIncrement(sourceIp: string): Promise<RateLimitResult> {
    const key = `bamform:auth:ratelimit:login:${sourceIp}`;
    const windowSeconds = 60;

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    if (count > this.limit) {
      const ttl = await this.redis.ttl(key);
      return { limited: true, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    }
    return { limited: false, retryAfterSeconds: 0 };
  }
}
