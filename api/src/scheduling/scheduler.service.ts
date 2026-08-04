import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { GenerateDueJobsResult } from './job-generation.service';
import { JobGenerationService, resolveDefaultLeadTimeDays } from './job-generation.service';
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
      const leadTimeDays = resolveDefaultLeadTimeDays(this.config.get('DEFAULT_LEAD_TIME_DAYS'));
      const result = await this.jobGeneration.generateDueJobs(new Date(), leadTimeDays);
      await this.redis.set(SCHEDULER_LAST_RUN_KEY, new Date().toISOString());
      this.logger.log(
        // Slice 32-PLANNERJOB adds the two assignment counters. `unavailable`
        // is the one to watch: it means a schedule named a standing assignee
        // who is no longer eligible, so PM went out with NOBODY on it — and an
        // unassigned job is invisible to every MAINTAINER (`job-access.ts`).
        `run complete: evaluated=${result.evaluated} generated=${result.generated} ` +
          `alreadyExists=${result.alreadyExists} skippedNoItems=${result.skippedNoItems} ` +
          `assignedFromDefault=${result.assignedFromDefault} ` +
          `defaultAssigneeUnavailable=${result.defaultAssigneeUnavailable}`,
      );
      return { ran: true, ...result };
    } finally {
      await this.lock.release(token);
    }
  }
}
