import { Controller, Get } from '@nestjs/common';
import type { ApprovalRoute } from '@bamform/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Slice 13-TL: `GET /approval-routes` — read-only, seeded reference data
 * (PR-DBD-09: `SINGLE_STAGE_TL_OR_ENG` and its stages arrive by migration;
 * routes are never created via the API). Exists because
 * `POST /asset-types` requires `approvalRouteId` and there was previously
 * no HTTP endpoint that could supply it — the BAMFORM-TLP-001 template
 * loader (and any future admin UI) would otherwise need a direct DB read.
 * Any authenticated user; global reference data, nothing area-scoped
 * (COLLECTION_ENDPOINTS classification in api/test/contract/known-gaps.ts).
 */
@Controller('approval-routes')
export class ApprovalRoutesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(): Promise<ApprovalRoute[]> {
    const rows = await this.prisma.approvalRoute.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, active: true },
    });
    return rows;
  }
}
