import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { GenerateDueJobsResult } from './job-generation.service';
import { JobGenerationService } from './job-generation.service';
import { ScheduleRuleBootstrapService } from './schedule-rule-bootstrap.service';
import { SchedulerLockService } from './scheduler-lock.service';

export const SCHEDULER_LAST_RUN_KEY = 'bf:scheduler:last-run';

export type SchedulerRunResult =
  { ran: false; reason: 'locked' } | ({ ran: true } & GenerateDueJobsResult);

/**
 * PR-050/051 orchestrator — one evaluation run: acquire the Redis lock,
 * self-heal any missing `schedule_rule` rows (`ScheduleRuleBootstrapService`),
 * generate due jobs (`JobGenerationService`), record the last-run timestamp
 * (PR-ENV-23: "the most important operational signal in the system" —
 * `docs/ENVIRONMENT_REQUIREMENTS.md`), then release the lock. `worker.ts`
 * calls `run()` once per matching cron tick; nothing else should.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly lock: SchedulerLockService,
    private readonly bootstrap: ScheduleRuleBootstrapService,
    private readonly jobGeneration: JobGenerationService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async run(): Promise<SchedulerRunResult> {
    const ttlSeconds = Number(this.config.get('SCHEDULER_LOCK_TTL_SECONDS') ?? 300);
    const token = await this.lock.acquire(ttlSeconds);
    if (!token) {
      this.logger.log('lock held elsewhere — skipping this tick');
      return { ran: false, reason: 'locked' };
    }

    try {
      await this.bootstrap.ensureForAllActiveAssets();
      const leadTimeDays = Number(this.config.get('DEFAULT_LEAD_TIME_DAYS') ?? 30);
      const result = await this.jobGeneration.generateDueJobs(new Date(), leadTimeDays);
      await this.redis.set(SCHEDULER_LAST_RUN_KEY, new Date().toISOString());
      this.logger.log(
        `run complete: evaluated=${result.evaluated} generated=${result.generated} alreadyExists=${result.alreadyExists} skippedNoItems=${result.skippedNoItems}`,
      );
      return { ran: true, ...result };
    } finally {
      await this.lock.release(token);
    }
  }
}
