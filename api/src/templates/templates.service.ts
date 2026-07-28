import { Injectable } from '@nestjs/common';
import { AuditActionT, Prisma } from '@prisma/client';
import type { CreateTemplateRequest, FormTemplate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { conflictProblem, notFoundProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { toFormTemplate } from './mappers';

/**
 * PR-021 `form_template`. The twelve source templates are loaded by
 * BAMFORM-TLP-001's tooling (PR-DBD-10) — slice 13-TL added the bounded
 * `create` below exactly for that tooling, because PR-TLP-07 requires the
 * load to run as an authenticated operation attributable to a named person,
 * producing audit events, through the real API (not a DB migration and not
 * direct DB writes). Everything else remains read-only; template CONTENT
 * still arrives only through the slice-4 revision-authoring endpoints.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreateTemplateRequest, actor: ActorMeta): Promise<FormTemplate> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.formTemplate.create({
          data: { documentNumber: dto.documentNumber, title: dto.title },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'form_template',
          entityId: row.id,
          after: { documentNumber: row.documentNumber, title: row.title },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return toFormTemplate(row, null, null);
      });
    } catch (error) {
      // INV-07: document numbers are unique. Loudly conflict — the loader's
      // idempotency comes from reading back, never from silent upserts.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem(
          `A form template with document number '${dto.documentNumber}' already exists.`,
        );
      }
      throw error;
    }
  }

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
