import { Injectable } from '@nestjs/common';
import type { Role as RoleRow } from '@prisma/client';
import type { Role, RoleCode } from '@bamform/shared';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    code: row.code as RoleCode,
    name: row.name,
    description: row.description,
  };
}

/**
 * UR-073 `role` catalogue (`api/prisma/migrations/20260723180100_seed_reference_data`:
 * seeded by migration, not created through the API — this is a read-only
 * lookup, unlike `UsersService`). Global reference data, no `areaId` column,
 * no role restriction beyond authentication (API_SPECIFICATION.md §10.9's
 * `/roles` row carries no "ADMIN only" annotation, unlike `/users`).
 */
@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { limit?: unknown; cursor?: string }): Promise<Page<Role>> {
    const limit = normaliseLimit(params.limit);
    const afterId = decodeCursor(params.cursor);

    const rows = await this.prisma.role.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = paginate(rows, limit);
    return { data: page.data.map(toRole), page: page.page };
  }
}
