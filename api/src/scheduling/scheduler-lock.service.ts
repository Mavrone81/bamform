import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * PR-051 — a Redis lock held for the duration of a scheduler evaluation run
 * so that duplicate jobs cannot be generated if more than one worker
 * instance runs (or one worker restarts mid-run). DBD §6.24: `bf:lock:scheduler`,
 * TTL `SCHEDULER_LOCK_TTL_SECONDS` (default 300s), renewed by re-acquiring
 * each tick — a crashed holder's lock still self-expires rather than
 * deadlocking every future run.
 *
 * `SET key value NX EX ttl` is the acquire (atomic: only succeeds if the key
 * doesn't already exist). Release is a compare-and-delete Lua script keyed
 * on a per-acquisition token, so a worker can never release a lock that a
 * DIFFERENT holder now owns (e.g. this worker's own TTL already expired and
 * another worker has since acquired it) — released is fine, but stealing
 * someone else's live lock defeats I-INV-15 entirely.
 */
@Injectable()
export class SchedulerLockService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private readonly key = 'bf:lock:scheduler';

  /** Returns the acquisition token on success, or `null` if the lock is held elsewhere. */
  async acquire(ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(this.key, token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? token : null;
  }

  /** No-ops if `token` no longer matches the current holder (already expired/stolen). */
  async release(token: string): Promise<void> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, this.key, token);
  }
}
