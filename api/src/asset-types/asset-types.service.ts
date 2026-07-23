import { Injectable } from '@nestjs/common';
import { AuditActionT, Prisma } from '@prisma/client';
import type { AssetType, AssetTypeCreate, AssetTypeUpdate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { conflictProblem, notFoundProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

type AssetTypeRow = Prisma.AssetTypeGetPayload<Record<string, never>>;

function toAssetType(row: AssetTypeRow): AssetType {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    formTemplateId: row.formTemplateId,
    approvalRouteId: row.approvalRouteId,
    leadTimeDays: row.leadTimeDays,
    active: row.active,
  };
}

/** PR-019 `asset_type` — one `form_template` per type (DBD §6.7, 1:1 unique index). */
@Injectable()
export class AssetTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(params: { limit?: unknown; cursor?: string }): Promise<Page<AssetType>> {
    const limit = normaliseLimit(params.limit);
    const afterId = decodeCursor(params.cursor);

    const rows = await this.prisma.assetType.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = paginate(rows, limit);
    return { data: page.data.map(toAssetType), page: page.page };
  }

  async get(id: string): Promise<AssetType> {
    const row = await this.prisma.assetType.findUnique({ where: { id } });
    if (!row) {
      throw notFoundProblem('Asset type', id);
    }
    return toAssetType(row);
  }

  async create(dto: AssetTypeCreate, actor: ActorMeta): Promise<AssetType> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.assetType.create({
          data: {
            code: dto.code,
            name: dto.name,
            description: dto.description,
            formTemplateId: dto.formTemplateId,
            approvalRouteId: dto.approvalRouteId,
            leadTimeDays: dto.leadTimeDays,
          },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'asset_type',
          entityId: row.id,
          after: toAssetType(row),
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return toAssetType(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = String(error.meta?.target ?? '');
        if (target.includes('form_template_id')) {
          throw conflictProblem(
            `form_template ${dto.formTemplateId} already governs another asset type (one template per type).`,
          );
        }
        throw conflictProblem(`Asset type code '${dto.code}' is already in use.`);
      }
      throw error;
    }
  }

  async update(id: string, dto: AssetTypeUpdate, actor: ActorMeta): Promise<AssetType> {
    const existing = await this.prisma.assetType.findUnique({ where: { id } });
    if (!existing) {
      throw notFoundProblem('Asset type', id);
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.assetType.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          leadTimeDays: dto.leadTimeDays,
          active: dto.active,
        },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'asset_type',
        entityId: row.id,
        before: toAssetType(existing),
        after: toAssetType(row),
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return toAssetType(row);
    });
  }
}
