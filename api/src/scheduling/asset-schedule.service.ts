import { Injectable } from '@nestjs/common';
import {
  AuditActionT,
  type AssetDocument,
  type ScheduleRule as ScheduleRuleRow,
} from '@prisma/client';
import type { ScheduleAdjustRequest, ScheduleRule } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { AreaScopeService } from '../common/area-scope';
import {
  notFoundProblem,
  outOfScopeProblem,
  validationFailedProblem,
} from '../common/domain-problems';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleRuleBootstrapService } from './schedule-rule-bootstrap.service';

type RuleWithDocument = ScheduleRuleRow & { assetDocument: AssetDocument };

function toDto(row: RuleWithDocument): ScheduleRule {
  return {
    id: row.id,
    assetDocumentId: row.assetDocumentId,
    assetId: row.assetDocument.assetId,
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

    // Slice 27: every rule across every ACTIVE document the machine carries.
    // The caller sees one flat list, as before; each row now names its
    // document. `active` matters (review m-6): a RETIRED document generates no
    // jobs (`job-generation.service.ts` filters the same way), so listing its
    // rules here would show a planner a schedule that will never produce work.
    const rows = await this.prisma.scheduleRule.findMany({
      where: { assetDocument: { assetId, active: true } },
      include: { assetDocument: true },
      orderBy: [{ assetDocumentId: 'asc' }, { intervalMonths: 'asc' }],
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

    // Slice 27 — `(assetId, frequency)` no longer identifies a rule once a
    // machine carries several documents. Adjusting whichever one happened to
    // come first would move the WRONG document's next-due date, silently, and
    // with an audit entry claiming it was intended. Refuse instead.
    const matches = await this.prisma.scheduleRule.findMany({
      where: {
        // Same `active` filter as the list above — a retired document is not
        // adjustable, and must not count toward the ambiguity below either,
        // since retiring one of two documents genuinely restores the
        // unambiguous case.
        assetDocument: { assetId, active: true },
        frequency: dto.frequency,
        ...(dto.assetDocumentId ? { assetDocumentId: dto.assetDocumentId } : {}),
      },
      include: { assetDocument: true },
    });

    if (matches.length === 0) {
      throw notFoundProblem(
        'ScheduleRule',
        `${assetId}/${dto.assetDocumentId ? `${dto.assetDocumentId}/` : ''}${dto.frequency}`,
      );
    }
    if (matches.length > 1) {
      throw validationFailedProblem(
        `This machine carries ${matches.length} documents scheduled at ${dto.frequency}. ` +
          'Name the one to adjust with `assetDocumentId` — adjusting the wrong document’s ' +
          'schedule would silently stop its PM coming due.',
      );
    }
    const existing = matches[0];

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.scheduleRule.update({
        where: { id: existing.id },
        data: {
          nextDueOn: new Date(dto.nextDueOn),
          adjustedReason: dto.adjustedReason,
        },
        include: { assetDocument: true },
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
