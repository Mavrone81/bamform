import { Injectable } from '@nestjs/common';
import { AuditActionT, Prisma, type Asset as AssetRow, type AssetType } from '@prisma/client';
import type { Asset, AssetCreate, AssetUpdate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { AreaScopeService } from '../common/area-scope';
import type { ActorMeta } from '../common/actor-meta';
import { conflictProblem, notFoundProblem, outOfScopeProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsRepository } from './assets.repository';

const STATUS_TO_DB: Record<string, 'active' | 'under_repair' | 'decommissioned'> = {
  ACTIVE: 'active',
  UNDER_REPAIR: 'under_repair',
  DECOMMISSIONED: 'decommissioned',
};
const STATUS_FROM_DB: Record<string, 'ACTIVE' | 'UNDER_REPAIR' | 'DECOMMISSIONED'> = {
  active: 'ACTIVE',
  under_repair: 'UNDER_REPAIR',
  decommissioned: 'DECOMMISSIONED',
};

type Row = AssetRow & { assetType?: AssetType };

function toAsset(row: Row): Asset {
  return {
    id: row.id,
    code: row.code,
    assetTypeId: row.assetTypeId,
    assetTypeName: row.assetType?.name,
    description: row.description,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serialNumber,
    areaId: row.areaId,
    locationDetail: row.locationDetail,
    commissionedOn: row.commissionedOn ? row.commissionedOn.toISOString().slice(0, 10) : null,
    scheduleAnchorDate: row.scheduleAnchorDate.toISOString().slice(0, 10),
    status: STATUS_FROM_DB[row.status],
    active: row.active,
  };
}

export interface ListAssetsParams {
  limit?: unknown;
  cursor?: string;
  assetTypeId?: string;
  areaId?: string;
  status?: string;
}

/** PR-020 `asset` — area scoping (PR-API-10) lives in `AssetsRepository`, never re-implemented here. */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AssetsRepository,
    private readonly areaScope: AreaScopeService,
    private readonly audit: AuditEventService,
  ) {}

  async list(userId: string, params: ListAssetsParams): Promise<Page<Asset>> {
    const limit = normaliseLimit(params.limit);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);

    const rows = await this.repo.findMany(
      {
        assetTypeId: params.assetTypeId,
        areaId: params.areaId,
        status: params.status ? STATUS_TO_DB[params.status] : undefined,
        afterId: decodeCursor(params.cursor),
        take: limit + 1,
      },
      allowedAreaIds,
    );

    const page = paginate(rows, limit);
    return { data: page.data.map(toAsset), page: page.page };
  }

  async get(userId: string, id: string): Promise<Asset> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw notFoundProblem('Asset', id);
    }
    await this.assertInScope(userId, row.areaId);
    return toAsset(row);
  }

  async history(userId: string, id: string, params: { limit?: unknown; cursor?: string }) {
    const row = await this.repo.findById(id);
    if (!row) {
      throw notFoundProblem('Asset', id);
    }
    await this.assertInScope(userId, row.areaId);

    // Jobs/records are slice 5/6/7 territory (scheduling, result capture,
    // approval) — this endpoint is real and area-scoping-correct today, it
    // simply has no rows to return yet since nothing generates `job` rows
    // in this slice.
    const limit = normaliseLimit(params.limit);
    return { data: [], page: { nextCursor: null, hasMore: false, limit } };
  }

  async create(dto: AssetCreate, actor: ActorMeta): Promise<Asset> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.asset.create({
          data: {
            code: dto.code,
            assetTypeId: dto.assetTypeId,
            description: dto.description,
            manufacturer: dto.manufacturer,
            model: dto.model,
            serialNumber: dto.serialNumber,
            areaId: dto.areaId,
            locationDetail: dto.locationDetail,
            commissionedOn: dto.commissionedOn ? new Date(dto.commissionedOn) : undefined,
            scheduleAnchorDate: new Date(dto.scheduleAnchorDate),
          },
          include: { assetType: true },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'asset',
          entityId: row.id,
          after: toAsset(row),
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return toAsset(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem(`Asset code '${dto.code}' is already in use.`);
      }
      throw error;
    }
  }

  async update(userId: string, id: string, dto: AssetUpdate, actor: ActorMeta): Promise<Asset> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw notFoundProblem('Asset', id);
    }
    await this.assertInScope(userId, existing.areaId);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: {
          description: dto.description,
          manufacturer: dto.manufacturer,
          model: dto.model,
          areaId: dto.areaId,
          locationDetail: dto.locationDetail,
          status: dto.status ? STATUS_TO_DB[dto.status] : undefined,
          active: dto.active,
        },
        include: { assetType: true },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'asset',
        entityId: row.id,
        before: toAsset(existing),
        after: toAsset(row),
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return toAsset(row);
    });
  }

  /** PR-API-10 for by-id reads: exists but out of scope is 403, not a silent 404. */
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
