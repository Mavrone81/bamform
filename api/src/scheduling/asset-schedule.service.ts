import { Injectable } from '@nestjs/common';
import { AuditActionT, type ScheduleRule as ScheduleRuleRow } from '@prisma/client';
import type { ScheduleAdjustRequest, ScheduleRule } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { AreaScopeService } from '../common/area-scope';
import { notFoundProblem, outOfScopeProblem } from '../common/domain-problems';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleRuleBootstrapService } from './schedule-rule-bootstrap.service';

function toDto(row: ScheduleRuleRow): ScheduleRule {
  return {
    id: row.id,
    assetId: row.assetId,
    frequency: row.frequency as unknown as ScheduleRule['frequency'],
    intervalMonths: row.intervalMonths,
    anchorDate: row.anchorDate.toISOString().slice(0, 10),
    lastCompletedOn: row.lastCompletedOn ? row.lastCompletedOn.toISOString().slice(0, 10) : null,
    nextDueOn: row.nextDueOn.toISOString().slice(0, 10),
    adjustedReason: row.adjustedReason,
    active: row.active,
  };
}

/**
 * `GET`/`PUT /assets/{assetId}/schedule` — PR-058/UR-023/UR-025. Area
 * scoping mirrors `AssetsService`'s by-id reads exactly (403 out-of-scope,
 * never a silent 404 for an asset the caller simply can't see).
 */
@Injectable()
export class AssetScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly areaScope: AreaScopeService,
    private readonly audit: AuditEventService,
    private readonly bootstrap: ScheduleRuleBootstrapService,
  ) {}

  async list(userId: string, assetId: string): Promise<ScheduleRule[]> {
    const asset = await this.getAssetOrThrow(assetId);
    await this.assertInScope(userId, asset.areaId);

    // Lazily self-heal: an asset onboarded after this feature existed may
    // not have schedule_rule rows yet (see ScheduleRuleBootstrapService).
    await this.bootstrap.ensureForAsset(assetId);

    const rows = await this.prisma.scheduleRule.findMany({
      where: { assetId },
      orderBy: { intervalMonths: 'asc' },
    });
    return rows.map(toDto);
  }

  async adjust(
    userId: string,
    assetId: string,
    dto: ScheduleAdjustRequest,
    actor: ActorMeta,
  ): Promise<ScheduleRule> {
    const asset = await this.getAssetOrThrow(assetId);
    await this.assertInScope(userId, asset.areaId);

    const existing = await this.prisma.scheduleRule.findUnique({
      where: { assetId_frequency: { assetId, frequency: dto.frequency } },
    });
    if (!existing) {
      throw notFoundProblem('ScheduleRule', `${assetId}/${dto.frequency}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.scheduleRule.update({
        where: { id: existing.id },
        data: {
          nextDueOn: new Date(dto.nextDueOn),
          adjustedReason: dto.adjustedReason,
        },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'schedule_rule',
        entityId: row.id,
        before: toDto(existing),
        after: toDto(row),
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return toDto(row);
    });
  }

  private async getAssetOrThrow(assetId: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) {
      throw notFoundProblem('Asset', assetId);
    }
    return asset;
  }

  private async assertInScope(userId: string, areaId: string | null): Promise<void> {
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    if (allowedAreaIds === null) {
      return;
    }
    if (!areaId || !allowedAreaIds.includes(areaId)) {
      throw outOfScopeProblem('Asset');
    }
  }
}
