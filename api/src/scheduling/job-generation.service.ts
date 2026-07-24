import { Injectable, Logger } from '@nestjs/common';
import {
  AuditActionT,
  JobStatusT,
  Prisma,
  type Asset,
  type AssetType,
  type ScheduleRule,
} from '@prisma/client';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveCascadeFrequencyScope, resolveCascadeItems } from './frequency-cascade';

export interface GenerateDueJobsResult {
  /** schedule_rule rows whose asset/lead-time made them candidates this run. */
  evaluated: number;
  /** New `job` rows inserted this run. */
  generated: number;
  /** Candidates that already had a matching job (PR-052 idempotency — I-INV-14). */
  alreadyExists: number;
  /** Candidates skipped because the template has no active items in scope, or no current revision. */
  skippedNoItems: number;
}

type RuleWithAsset = ScheduleRule & { asset: Asset & { assetType: AssetType } };

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** `Date`-only (no time-of-day) comparison — `due_on`/`next_due_on` are DATE columns. */
function dateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * PR-050/PR-052 — evaluates every active `schedule_rule` due within its
 * asset type's lead time and generates the `job` rows PR-053's cascade
 * says are missing. Idempotent: a repeated call (whether because the
 * scheduler tick simply runs twice, or a worker crashed after insert but
 * before its surrounding bookkeeping committed) creates no duplicate
 * (I-INV-14) — enforced by the database (`job`'s
 * `(asset_id, frequency_scope, due_on)` unique index, not merely an
 * application-level check-then-insert, which would leave a TOCTOU race
 * inside a single process's own run).
 *
 * Concurrency ACROSS worker instances is `SchedulerLockService`'s job
 * (PR-051, I-INV-15) — this service assumes it is never invoked twice
 * concurrently for the same tick.
 */
@Injectable()
export class JobGenerationService {
  private readonly logger = new Logger(JobGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async generateDueJobs(today: Date, defaultLeadTimeDays: number): Promise<GenerateDueJobsResult> {
    const rules = (await this.prisma.scheduleRule.findMany({
      where: { active: true },
      include: { asset: { include: { assetType: true } } },
    })) as RuleWithAsset[];

    const result: GenerateDueJobsResult = {
      evaluated: 0,
      generated: 0,
      alreadyExists: 0,
      skippedNoItems: 0,
    };

    for (const rule of rules) {
      const asset = rule.asset;
      // U-SCH-05: a deactivated asset generates no further jobs.
      if (!asset.active || asset.status !== 'active') {
        continue;
      }

      const leadTimeDays = asset.assetType.leadTimeDays ?? defaultLeadTimeDays;
      const cutoff = addDays(dateOnly(today), leadTimeDays);
      if (dateOnly(rule.nextDueOn) > cutoff) {
        continue; // not due within the lead-time window yet
      }

      result.evaluated += 1;
      const outcome = await this.generateForRule(rule, asset);
      if (outcome === 'generated') result.generated += 1;
      else if (outcome === 'exists') result.alreadyExists += 1;
      else result.skippedNoItems += 1;
    }

    return result;
  }

  private async generateForRule(
    rule: RuleWithAsset,
    asset: Asset & { assetType: AssetType },
  ): Promise<'generated' | 'exists' | 'skipped'> {
    const revision = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: asset.assetType.formTemplateId, status: 'current' },
    });
    if (!revision) {
      return 'skipped';
    }

    const activeItems = await this.prisma.templateItem.findMany({
      where: { templateRevisionId: revision.id, active: true },
      select: { frequency: true },
    });
    const candidates = activeItems.map((item) => ({
      frequency: item.frequency as unknown as Frequency,
      intervalMonths: FREQUENCY_INTERVAL_MONTHS[item.frequency as unknown as Frequency],
    }));

    const standingContent = revision.standingContent as {
      cascadeOverride?: Record<string, string[]>;
    } | null;
    const override = standingContent?.cascadeOverride?.[rule.frequency] as Frequency[] | undefined;

    const resolvedItems = resolveCascadeItems(rule.intervalMonths, candidates, override);
    if (resolvedItems.length === 0) {
      return 'skipped';
    }
    const frequencyScope = resolveCascadeFrequencyScope(rule.intervalMonths, candidates, override);

    try {
      await this.prisma.$transaction(async (tx) => {
        const jobNumber = await this.nextJobNumber(tx, rule.nextDueOn.getUTCFullYear());
        const job = await tx.job.create({
          data: {
            jobNumber,
            assetId: asset.id,
            templateRevisionId: revision.id,
            approvalRouteId: asset.assetType.approvalRouteId,
            frequency: rule.frequency,
            frequencyScope,
            dueOn: rule.nextDueOn,
            generatedAt: new Date(),
            status: JobStatusT.scheduled,
          },
        });

        await this.audit.record(tx, {
          actorId: null,
          action: AuditActionT.create,
          entityType: 'job',
          entityId: job.id,
          after: {
            jobNumber: job.jobNumber,
            assetId: asset.id,
            frequency: rule.frequency,
            frequencyScope,
            dueOn: job.dueOn,
          },
        });
      });
      return 'generated';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // I-INV-14: (asset_id, frequency_scope, due_on) already has a job — idempotent no-op.
        this.logger.debug(
          `job already generated for asset=${asset.id} scope=${frequencyScope.join(',')} due=${rule.nextDueOn.toISOString()}`,
        );
        return 'exists';
      }
      throw error;
    }
  }

  /** `PM-{year}-{6-digit sequence}` (DBD §6.15), sequenced within the transaction that inserts the job. */
  private async nextJobNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
    const prefix = `PM-${year}-`;
    const last = await tx.job.findFirst({
      where: { jobNumber: { startsWith: prefix } },
      orderBy: { jobNumber: 'desc' },
      select: { jobNumber: true },
    });
    const lastSeq = last ? Number(last.jobNumber.slice(prefix.length)) : 0;
    return `${prefix}${String(lastSeq + 1).padStart(6, '0')}`;
  }
}
