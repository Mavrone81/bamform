import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * BullMQ requires its own dedicated ioredis connection per `Queue`/`Worker`
 * (its blocking commands are incompatible with sharing `RedisModule`'s
 * general-purpose client — BullMQ's own docs call this out) and
 * `maxRetriesPerRequest: null` specifically (BullMQ throws at construction
 * otherwise). `REDIS_URL`/`QUEUE_PREFIX` are the same env vars slice 1's
 * `.env.example` already documents (`QUEUE_PREFIX` was reserved for exactly
 * this — PR-009 — since before this slice).
 */
export function buildBullConnection(config: ConfigService): Redis {
  const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function bullQueuePrefix(config: ConfigService): string {
  return config.get<string>('QUEUE_PREFIX') ?? 'bull';
}
