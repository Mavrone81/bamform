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

  /**
   * Slice 13-MFA fix pass (review finding I-2) — denylist a `jti` ATOMICALLY,
   * reporting whether THIS caller was the one that burned it.
   *
   * `isDenylisted()` followed by `denylist()` is a read-then-write race: N
   * concurrent redemptions of one single-use credential all read "not
   * denylisted" before any of them writes, and all N succeed. `SET NX` makes
   * the check and the write one Redis command, so exactly one caller can ever
   * observe `true` for a given `jti`. That is what makes the MFA challenge
   * token single-use under concurrency and not merely in sequence.
   *
   * The TTL is clamped to at least one second: a `jti` whose token has
   * already expired cannot reach here (the guard verifies `exp` first), and
   * writing nothing would silently hand every concurrent caller a `true`.
   */
  async claim(jti: string, remainingTtlSeconds: number): Promise<boolean> {
    const ttl = Math.max(1, Math.ceil(remainingTtlSeconds));
    const result = await this.redis.set(this.key(jti), '1', 'EX', ttl, 'NX');
    return result === 'OK';
  }

  async isDenylisted(jti: string): Promise<boolean> {
    const value = await this.redis.get(this.key(jti));
    return value !== null;
  }
}
