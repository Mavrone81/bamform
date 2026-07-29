import { Injectable, Logger } from '@nestjs/common';
import {
  AuditActionT,
  JobStatusT,
  Prisma,
  type Asset,
  type AssetDocument,
  type AssetType,
  type ScheduleRule,
} from '@prisma/client';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveCascadeFrequencyScope, resolveCascadeItems } from './frequency-cascade';
import { nextJobNumber } from './job-number';

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

/**
 * Slice 27-ASSETDOC: a rule reaches its machine THROUGH its document. The
 * template comes from the document; the approval route and lead time still come
 * from the machine's asset type (both are family-wide properties — the approval
 * chain is a property of the machine family, not of the document).
 */
type RuleWithDocument = ScheduleRule & {
  assetDocument: AssetDocument & { asset: Asset & { assetType: AssetType } };
};

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
 * `(asset_document_id, frequency_scope, due_on)` partial unique index, not merely an
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
      // U-SCH-05 extended by slice 27: a DEACTIVATED document generates no
      // further jobs, exactly as a deactivated asset does not. Deactivation
      // (never deletion, INV-16) is how an admin retires a document while its
      // history stays resolvable.
      where: { active: true, assetDocument: { active: true } },
      include: { assetDocument: { include: { asset: { include: { assetType: true } } } } },
    })) as RuleWithDocument[];

    const result: GenerateDueJobsResult = {
      evaluated: 0,
      generated: 0,
      alreadyExists: 0,
      skippedNoItems: 0,
    };

    for (const rule of rules) {
      const asset = rule.assetDocument.asset;
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
    rule: RuleWithDocument,
    asset: Asset & { assetType: AssetType },
  ): Promise<'generated' | 'exists' | 'skipped'> {
    // Slice 27: the form comes from the DOCUMENT. Two documents on one machine
    // therefore raise jobs against two DIFFERENT template revisions — which is
    // the whole point, and was impossible while the template was reached
    // through `asset.assetType.formTemplateId`.
    const revision = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: rule.assetDocument.formTemplateId, status: 'current' },
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
        const jobNumber = await nextJobNumber(tx, rule.nextDueOn.getUTCFullYear());
        const job = await tx.job.create({
          data: {
            jobNumber,
            assetId: asset.id,
            assetDocumentId: rule.assetDocument.id,
            templateRevisionId: revision.id,
            // Unchanged, deliberately: the approval chain is a property of the
            // machine family, not of the document. Only the FORM moved.
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
            assetDocumentId: rule.assetDocument.id,
            frequency: rule.frequency,
            frequencyScope,
            dueOn: job.dueOn,
          },
        });
      });
      return 'generated';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // I-INV-14: (asset_document_id, frequency_scope, due_on) already has a
        // job — idempotent no-op. Keyed by DOCUMENT since slice 27: under the
        // old asset-keyed index a second document due the same day at the same
        // frequency landed here and was silently never raised.
        this.logger.debug(
          `job already generated for document=${rule.assetDocument.id} scope=${frequencyScope.join(',')} due=${rule.nextDueOn.toISOString()}`,
        );
        return 'exists';
      }
      throw error;
    }
  }
}
