import { Injectable } from '@nestjs/common';
import type { FormTemplate } from '@bamform/shared';
import { notFoundProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { toFormTemplate } from './mappers';

/**
 * PR-021 `form_template`. Read-only in this slice — the twelve source
 * templates are loaded by BAMFORM-TLP-001's separate tooling (PR-DBD-10),
 * not through this API; there is deliberately no `POST /templates` here.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { limit?: unknown; cursor?: string }): Promise<Page<FormTemplate>> {
    const limit = normaliseLimit(params.limit);
    const afterId = decodeCursor(params.cursor);

    const rows = await this.prisma.formTemplate.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: { assetTypes: true },
    });

    const page = paginate(rows, limit);
    const data = await Promise.all(
      page.data.map(async (row) => {
        const current = await this.prisma.templateRevision.findFirst({
          where: { formTemplateId: row.id, status: 'current' },
          select: { id: true },
        });
        return toFormTemplate(row, row.assetTypes[0]?.id ?? null, current?.id ?? null);
      }),
    );

    return { data, page: page.page };
  }

  async get(id: string): Promise<FormTemplate> {
    const row = await this.prisma.formTemplate.findUnique({
      where: { id },
      include: { assetTypes: true },
    });
    if (!row) {
      throw notFoundProblem('Form template', id);
    }
    const current = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: id, status: 'current' },
      select: { id: true },
    });
    return toFormTemplate(row, row.assetTypes[0]?.id ?? null, current?.id ?? null);
  }
}
