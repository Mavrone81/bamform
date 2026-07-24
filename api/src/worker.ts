import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { RedactingLogger } from './common/logging/redacting-logger';
import { REDIS_CLIENT } from './redis/redis.module';
import { cronMatches } from './scheduling/cron';
import { SchedulerService } from './scheduling/scheduler.service';
import { WorkerModule } from './worker.module';

/**
 * `bamform-worker` entrypoint (`dist/worker.js` — docker-compose.yml's
 * `bamform-worker` service `command`). Slice 5's second deliverable
 * alongside the scheduling engine itself: this container previously had no
 * entrypoint at all, which blocked the production deploy.
 *
 * A real cadence-driven bootstrap, not a stub: ticks on a short fixed
 * interval (`TICK_INTERVAL_MS`), refreshes a Redis heartbeat key every tick
 * regardless of `SCHEDULER_ENABLED` (`docs/ENVIRONMENT_REQUIREMENTS.md`:
 * "Queue heartbeat key in Redis" is the documented worker healthcheck
 * signal — see `worker-healthcheck.ts`), and calls
 * `SchedulerService#run()` (PR-050/051 — lock + generation) once per
 * matching `SCHEDULER_CRON` minute when `SCHEDULER_ENABLED=true`.
 *
 * Deliberately ticks far more often than the default hourly cron rather
 * than trying to compute "next fire time" and sleep until then — simpler,
 * and immune to clock-adjustment/DST edge cases a sleep-based scheduler
 * would need to handle explicitly.
 */

const TICK_INTERVAL_MS = 20_000;
const HEARTBEAT_KEY = 'bf:scheduler:heartbeat';
const HEARTBEAT_TTL_SECONDS = 300;

function minuteKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new RedactingLogger(WorkerModule.name);
  app.useLogger(logger);

  const config = app.get(ConfigService);
  const redis = app.get<Redis>(REDIS_CLIENT);
  const scheduler = app.get(SchedulerService);

  const enabled = (config.get<string>('SCHEDULER_ENABLED') ?? 'true') !== 'false';
  const cron = config.get<string>('SCHEDULER_CRON') ?? '0 * * * *';

  logger.log(`worker starting — SCHEDULER_ENABLED=${enabled} SCHEDULER_CRON="${cron}"`);

  let lastFiredMinuteKey: string | null = null;
  let shuttingDown = false;
  let tickInFlight = false;

  const tick = async (): Promise<void> => {
    if (tickInFlight) return; // a slow run must not overlap the next tick
    tickInFlight = true;
    try {
      const now = new Date();
      await redis.set(HEARTBEAT_KEY, now.toISOString(), 'EX', HEARTBEAT_TTL_SECONDS);

      if (!enabled) {
        return;
      }

      const currentMinuteKey = minuteKeyOf(now);
      if (currentMinuteKey === lastFiredMinuteKey) {
        return; // already ran the scheduler for this matching minute
      }
      if (!cronMatches(cron, now)) {
        return;
      }

      lastFiredMinuteKey = currentMinuteKey;
      const result = await scheduler.run();
      logger.log(`scheduler run: ${JSON.stringify(result)}`);
    } catch (error) {
      const err = error as Error;
      logger.error(`tick failed: ${err.message}`, err.stack);
    } finally {
      tickInFlight = false;
    }
  };

  const timer = setInterval(() => {
    if (!shuttingDown) void tick();
  }, TICK_INTERVAL_MS);

  await tick(); // heartbeat set immediately rather than waiting a full interval after startup

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`received ${signal}, shutting down`);
    clearInterval(timer);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
