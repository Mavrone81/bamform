import { Injectable } from '@nestjs/common';
import {
  AuditActionT,
  JobStatusT,
  Prisma,
  type AssetDocument as AssetDocumentRow,
} from '@prisma/client';
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
import {
  archivedRecordTitleDependencyProblem,
  conflictProblem,
  notFoundProblem,
  outOfScopeProblem,
} from '../common/domain-problems';
import { PrismaService } from '../prisma/prisma.service';
import {
  recordsBlockingMachineNumberChange,
  type ArchivedRecordTitle,
} from './archived-title-dependency';

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
 * The machine number a record prints from ITSELF, or `null` when it has none
 * and therefore falls back to `asset_document.machine_number`.
 *
 * This mirrors the fallback order in `pdf-record-assembly.service.ts` — the
 * single place that decides what a record's title actually prints — and must
 * be kept in step with it. The cast is deliberate and is what makes the guard
 * correct on both sides of slice 31-TITLEBLANK: on `main` there is no
 * per-record column, so this reads `undefined` and every archived record is
 * judged against the document's value (correct — that is its only source);
 * once `job.title_machine_number` exists it reads the captured value, and a
 * record carrying its own is correctly treated as unaffected by this edit.
 *
 * Typed as an optional read rather than `any` so a future rename of the column
 * fails the `??` intent visibly here rather than silently widening the guard.
 */
function ownMachineNumber(job: object): string | null {
  return (job as { titleMachineNumber?: string | null }).titleMachineNumber ?? null;
}

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

    // INV-09 — refuse a machine-number edit that would rewrite the title
    // printed on an already-archived, signed record. Scoped to a machine
    // number that is actually CHANGING: `active` toggles and no-op re-sends
    // never reach it, because neither can alter what any record prints.
    if (dto.machineNumber !== undefined && dto.machineNumber !== existing.machineNumber) {
      await this.assertNoArchivedRecordDependsOnMachineNumber(existing, dto.machineNumber);
    }

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

  /**
   * INV-09 — the archived-record guard for `machine_number`.
   *
   * The exposure this closes: `resolveTemplateTitle` substitutes
   * `asset_document.machine_number` into the template title at RENDER
   * (`pdf-record-assembly.service.ts`), and `pdf-render.service.ts` re-renders
   * a record's PDF live from current data on every request — nothing is frozen
   * at archive. So editing this one field rewrote the title printed on records
   * signed months earlier, and `GET /records/{id}/integrity` still reported
   * `intact: true`, because neither the machine number nor the resolved title
   * is part of the canonical signed record (`canonical-job-record.ts`).
   *
   * SCOPE, stated plainly so nobody over-reads it: this guards THIS endpoint.
   * It is not a general immutability property of an archived record's printed
   * content — that would need the frozen artefact slice 23-PDFA only ever
   * planned, or a guard on every other write path that feeds
   * `pdf-record-assembly.service.ts`.
   *
   * VOIDED records are deliberately NOT counted. `archived -> VOID` is legal
   * (`job-state-machine.ts`), so a record voided after archiving leaves this
   * guard's reach — see the branch report; widening the rule to `voided` is an
   * owner decision, not a tidy-up, because `voided` is also reachable from
   * SCHEDULED/ASSIGNED/IN_PROGRESS, which were never signed.
   */
  private async assertNoArchivedRecordDependsOnMachineNumber(
    existing: RowWithTemplate,
    proposed: string | null,
  ): Promise<void> {
    const archivedJobs = await this.prisma.job.findMany({
      where: { assetDocumentId: existing.id, status: JobStatusT.archived },
      // `include`, NOT `select`: it returns every `job` scalar, which is what
      // lets `ownMachineNumber` below read a per-record machine number that
      // exists on some branches and not others without naming a column that
      // may not be in this schema. Every `job` scalar is small (no blobs, no
      // ciphertext — see `schema.prisma`), and the row set is bounded by one
      // document's archived history.
      include: {
        templateRevision: { select: { formTemplate: { select: { title: true } } } },
      },
      orderBy: { jobNumber: 'asc' },
    });

    const records: ArchivedRecordTitle[] = archivedJobs.map((job) => ({
      jobNumber: job.jobNumber,
      templateTitle: job.templateRevision.formTemplate.title,
      ownMachineNumber: ownMachineNumber(job),
    }));

    const blocking = recordsBlockingMachineNumberChange(records, existing.machineNumber, proposed);
    if (blocking.length === 0) {
      return;
    }

    // Quote the FIRST blocking record's before/after. Records on this document
    // can sit on different revisions, so there is no single "the" title —
    // naming one real record's real title beats a synthesised one.
    const [first] = blocking;
    throw archivedRecordTitleDependencyProblem({
      blockingJobNumbers: blocking.map((r) => r.jobNumber),
      currentTitle: resolveTemplateTitle(first.templateTitle, existing.machineNumber),
      proposedTitle: resolveTemplateTitle(first.templateTitle, proposed),
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
