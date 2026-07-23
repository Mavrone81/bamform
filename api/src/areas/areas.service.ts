import { Injectable } from '@nestjs/common';
import { AuditActionT, Prisma } from '@prisma/client';
import type { Area, AreaCreate, AreaUpdate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { conflictProblem, notFoundProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

type AreaRow = Prisma.AreaGetPayload<Record<string, never>>;

function toArea(row: AreaRow): Area {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parentId,
    active: row.active,
  };
}

@Injectable()
export class AreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(params: { limit?: unknown; cursor?: string }): Promise<Page<Area>> {
    const limit = normaliseLimit(params.limit);
    const afterId = decodeCursor(params.cursor);

    const rows = await this.prisma.area.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = paginate(rows, limit);
    return { data: page.data.map(toArea), page: page.page };
  }

  async get(id: string): Promise<Area> {
    const row = await this.prisma.area.findUnique({ where: { id } });
    if (!row) {
      throw notFoundProblem('Area', id);
    }
    return toArea(row);
  }

  async create(dto: AreaCreate, actor: ActorMeta): Promise<Area> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.area.create({
          data: {
            code: dto.code,
            name: dto.name,
            parentId: dto.parentId,
          },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'area',
          entityId: row.id,
          after: { code: row.code, name: row.name },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return toArea(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem(`Area code '${dto.code}' is already in use.`);
      }
      throw error;
    }
  }

  async update(id: string, dto: AreaUpdate, actor: ActorMeta): Promise<Area> {
    const existing = await this.prisma.area.findUnique({ where: { id } });
    if (!existing) {
      throw notFoundProblem('Area', id);
    }

    return this.prisma.$transaction(async (tx) => {
      const before = toArea(existing);
      const row = await tx.area.update({
        where: { id },
        data: {
          name: dto.name,
          parentId: dto.parentId,
          active: dto.active,
        },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'area',
        entityId: row.id,
        before,
        after: toArea(row),
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return toArea(row);
    });
  }
}
