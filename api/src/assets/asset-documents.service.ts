import { Injectable } from '@nestjs/common';
import { AuditActionT, Prisma, type AssetDocument as AssetDocumentRow } from '@prisma/client';
import {
  resolveTemplateTitle,
  titleHasFillableRun,
  type AssetDocument,
  type AssetDocumentCreate,
  type AssetDocumentUpdate,
} from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import { AreaScopeService } from '../common/area-scope';
import { conflictProblem, notFoundProblem, outOfScopeProblem } from '../common/domain-problems';
import { PrismaService } from '../prisma/prisma.service';

type RowWithTemplate = AssetDocumentRow & {
  formTemplate: { documentNumber: string; title: string };
};

function toDto(row: RowWithTemplate): AssetDocument {
  const title = row.formTemplate.title;
  return {
    id: row.id,
    assetId: row.assetId,
    formTemplateId: row.formTemplateId,
    documentNumber: row.formTemplate.documentNumber,
    title,
    // Derived, never stored — see `assetDocumentSchema`'s note.
    resolvedTitle: resolveTemplateTitle(title, row.machineNumber),
    titleHasFillableRun: titleHasFillableRun(title),
    machineNumber: row.machineNumber,
    active: row.active,
  };
}

const INCLUDE_TEMPLATE = {
  formTemplate: { select: { documentNumber: true, title: true } },
} as const;

/**
 * Slice 27-ASSETDOC §4.6 — tagging PM documents to a machine.
 *
 * The owner's process step 2 ("Admin will log in to setup the machine tagged
 * with which preventive Maintenance document") writes here; step 4 ("he will go
 * to his assigned machine and select the form to start") reads here.
 *
 * Area scoping mirrors `AssetsService`'s by-id reads exactly — 403 out-of-scope,
 * never a silent 404 for a machine the caller simply cannot see.
 */
@Injectable()
export class AssetDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly areaScope: AreaScopeService,
    private readonly audit: AuditEventService,
  ) {}

  async list(userId: string, assetId: string): Promise<{ data: AssetDocument[] }> {
    await this.getAssetInScopeOrThrow(userId, assetId);
    const rows = await this.prisma.assetDocument.findMany({
      where: { assetId },
      include: INCLUDE_TEMPLATE,
      orderBy: { id: 'asc' },
    });
    // Deactivated documents are LISTED, not hidden: a machine's history has to
    // stay visible. It is the scheduler that stops raising work for them.
    return { data: rows.map(toDto) };
  }

  async create(
    userId: string,
    assetId: string,
    dto: AssetDocumentCreate,
    actor: ActorMeta,
  ): Promise<AssetDocument> {
    await this.getAssetInScopeOrThrow(userId, assetId);

    const template = await this.prisma.formTemplate.findUnique({
      where: { id: dto.formTemplateId },
    });
    if (!template) {
      throw notFoundProblem('Form template', dto.formTemplateId);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.assetDocument.create({
          data: {
            assetId,
            formTemplateId: dto.formTemplateId,
            machineNumber: dto.machineNumber ?? null,
          },
          include: INCLUDE_TEMPLATE,
        });
        const dtoOut = toDto(row);

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'asset_document',
          entityId: row.id,
          after: dtoOut,
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return dtoOut;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem(
          `This machine already carries document ${template.documentNumber}. A document is tagged to a machine once; change the form number with PATCH /asset-documents/{id} instead.`,
        );
      }
      throw error;
    }
  }

  async update(
    userId: string,
    id: string,
    dto: AssetDocumentUpdate,
    actor: ActorMeta,
  ): Promise<AssetDocument> {
    const existing = await this.prisma.assetDocument.findUnique({
      where: { id },
      include: INCLUDE_TEMPLATE,
    });
    if (!existing) {
      throw notFoundProblem('Asset document', id);
    }
    await this.getAssetInScopeOrThrow(userId, existing.assetId);

    // No DELETE anywhere in this service (INV-16): `active: false` is the only
    // removal, and it leaves every job this document already generated
    // resolvable.
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.assetDocument.update({
        where: { id },
        data: {
          ...(dto.machineNumber !== undefined ? { machineNumber: dto.machineNumber } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedAt: new Date(),
        },
        include: INCLUDE_TEMPLATE,
      });
      const dtoOut = toDto(row);

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'asset_document',
        entityId: row.id,
        before: toDto(existing),
        after: dtoOut,
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return dtoOut;
    });
  }

  private async getAssetInScopeOrThrow(userId: string, assetId: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) {
      throw notFoundProblem('Asset', assetId);
    }
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    if (allowedAreaIds === null) {
      return asset;
    }
    if (!asset.areaId || !allowedAreaIds.includes(asset.areaId)) {
      throw outOfScopeProblem('Asset');
    }
    return asset;
  }
}
