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

    // Perf fix (slice-4-review, Important #2): resolve every page row's
    // CURRENT revision with one set-based query instead of a `findFirst`
    // per row — O(1) queries for the page, not O(N). `sequenceOrdinal`
    // is unique per template (INV-01/02), so `formTemplateId` alone already
    // identifies at most one CURRENT row each; no extra grouping needed.
    const templateIds = page.data.map((row) => row.id);
    const currentRevisions = templateIds.length
      ? await this.prisma.templateRevision.findMany({
          where: { formTemplateId: { in: templateIds }, status: 'current' },
          select: { id: true, formTemplateId: true },
        })
      : [];
    const currentByTemplateId = new Map(
      currentRevisions.map((rev) => [rev.formTemplateId, rev.id]),
    );

    const data = page.data.map((row) =>
      toFormTemplate(row, row.assetTypes[0]?.id ?? null, currentByTemplateId.get(row.id) ?? null),
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
