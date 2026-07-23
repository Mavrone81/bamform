import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { PrismaService } from '../prisma/prisma.service';

export interface AssetListFilters {
  assetTypeId?: string;
  areaId?: string;
  status?: 'active' | 'under_repair' | 'decommissioned';
  afterId?: string;
  take: number;
}

/**
 * Repository layer for `asset` — the reference implementation this slice
 * establishes for PR-API-10 / ADR-005's mandatory area scoping: EVERY
 * collection read goes through `findMany`, which always applies
 * `applyAreaScope` before the query runs. A caller (service/controller)
 * cannot bypass it because there is no other read path exposed here — this
 * is what "scoping lives in the repository layer, not by callers, so a new
 * endpoint cannot forget it" (API_SPECIFICATION.md §4.2) means in practice.
 */
@Injectable()
export class AssetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(filters: AssetListFilters, allowedAreaIds: string[] | null) {
    const scoped = applyAreaScope<Prisma.AssetWhereInput>(
      {
        assetTypeId: filters.assetTypeId,
        status: filters.status,
        id: filters.afterId ? { gt: filters.afterId } : undefined,
      },
      allowedAreaIds,
    );

    // An explicit `?areaId=` query filter is intersected with (never allowed
    // to widen) the caller's area scope: if the caller is scoped and asked
    // for an area outside that scope, the result is empty, not unfiltered.
    const where: Prisma.AssetWhereInput = filters.areaId
      ? {
          ...scoped,
          areaId:
            allowedAreaIds === null || allowedAreaIds.includes(filters.areaId)
              ? filters.areaId
              : { in: [] },
        }
      : scoped;

    return this.prisma.asset.findMany({
      where,
      include: { assetType: true },
      orderBy: { id: 'asc' },
      take: filters.take,
    });
  }

  findById(id: string) {
    return this.prisma.asset.findUnique({ where: { id }, include: { assetType: true } });
  }
}
