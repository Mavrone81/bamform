import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * PR-088: revocation uses a `jti` denylist in Redis with TTL equal to the
 * remaining access-token lifetime — so entries self-expire exactly when the
 * token they block would have expired anyway, never accumulating.
 */
@Injectable()
export class TokenDenylistService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(jti: string): string {
    return `bamform:auth:denylist:${jti}`;
  }

  async denylist(jti: string, remainingTtlSeconds: number): Promise<void> {
    if (remainingTtlSeconds <= 0) {
      return; // already expired — nothing to deny
    }
    await this.redis.set(this.key(jti), '1', 'EX', Math.ceil(remainingTtlSeconds));
  }

  async isDenylisted(jti: string): Promise<boolean> {
    const value = await this.redis.get(this.key(jti));
    return value !== null;
  }
}
