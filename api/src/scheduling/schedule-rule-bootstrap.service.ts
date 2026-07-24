import { Injectable, Logger } from '@nestjs/common';
import { AuditActionT, type Asset, type AssetType } from '@prisma/client';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DBD §6.14 `schedule_rule`: "ASSET ||--o{ SCHEDULE_RULE : has". Nothing in
 * the asset-creation flow (slice 4, `AssetsService.create`) populates these
 * rows, and the scheduler sweep (`JobGenerationService`) only ever reads
 * `schedule_rule` — so without something to create them, the entire
 * scheduling engine would be correct but permanently inert (no rows to
 * evaluate).
 *
 * This service is that "something", kept deliberately separate from
 * `AssetsService` (slice 4, already green, not touched here — BUILD_HANDOFF
 * §4 "one responsibility per file" plus not wanting to add scheduling-shaped
 * regression risk to already-tested asset-lifecycle code). It is:
 *
 *  - idempotent — relies on `schedule_rule`'s `(asset_id, frequency)` unique
 *    constraint (`createMany({ skipDuplicates: true })`), so calling it
 *    repeatedly, or for an asset that already has rows, never duplicates or
 *    overwrites a human's prior adjustment;
 *  - a no-op (not an error) when the asset's template has no CURRENT
 *    revision yet, or that revision has zero active items of any frequency
 *    — mirrors U-CAS-05's "no items to schedule, no error" spirit;
 *  - called from two places: `AssetScheduleService` (lazily, on first read
 *    of `GET /assets/{id}/schedule`) and `SchedulerService` (proactively, at
 *    the start of every sweep, for every active asset) — so a newly
 *    onboarded asset starts generating jobs without anyone needing to hit
 *    the schedule endpoint first.
 */
@Injectable()
export class ScheduleRuleBootstrapService {
  private readonly logger = new Logger(ScheduleRuleBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async ensureForAsset(assetId: string): Promise<void> {
    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      include: { assetType: true },
    });
    if (!asset) {
      return;
    }
    await this.ensureForOne(asset);
  }

  /** Used by the scheduler sweep so newly onboarded assets self-heal without a manual step. */
  async ensureForAllActiveAssets(): Promise<void> {
    const assets = await this.prisma.asset.findMany({
      where: { active: true, status: 'active' },
      include: { assetType: true },
    });
    for (const asset of assets) {
      await this.ensureForOne(asset);
    }
  }

  private async ensureForOne(asset: Asset & { assetType: AssetType }): Promise<void> {
    const revision = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: asset.assetType.formTemplateId, status: 'current' },
    });
    if (!revision) {
      return;
    }

    const activeItems = await this.prisma.templateItem.findMany({
      where: { templateRevisionId: revision.id, active: true },
      select: { frequency: true },
      distinct: ['frequency'],
    });
    if (activeItems.length === 0) {
      return;
    }

    const existing = await this.prisma.scheduleRule.findMany({
      where: { assetId: asset.id },
      select: { frequency: true },
    });
    const already = new Set(existing.map((row) => row.frequency));
    const missing = activeItems.filter((item) => !already.has(item.frequency));
    if (missing.length === 0) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.scheduleRule.createMany({
        data: missing.map((item) => ({
          assetId: asset.id,
          frequency: item.frequency,
          intervalMonths: FREQUENCY_INTERVAL_MONTHS[item.frequency as unknown as Frequency],
          anchorDate: asset.scheduleAnchorDate,
          nextDueOn: asset.scheduleAnchorDate,
          active: true,
        })),
        skipDuplicates: true,
      });

      if (result.count > 0) {
        await this.audit.record(tx, {
          actorId: null,
          action: AuditActionT.create,
          entityType: 'schedule_rule',
          entityId: asset.id,
          after: { assetId: asset.id, frequenciesCreated: missing.map((item) => item.frequency) },
        });
        this.logger.log(
          `bootstrapped ${result.count} schedule_rule row(s) for asset ${asset.id} (${missing
            .map((item) => item.frequency)
            .join(',')})`,
        );
      }
    });
  }
}
