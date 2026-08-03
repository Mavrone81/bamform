import { Injectable } from '@nestjs/common';
import {
  AuditActionT,
  JobStatusT,
  Prisma,
  type Asset as AssetRow,
  type AssetType,
} from '@prisma/client';
import type { Asset, AssetCreate, AssetUpdate } from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { AreaScopeService } from '../common/area-scope';
import type { ActorMeta } from '../common/actor-meta';
import {
  archivedRecordDependencyProblem,
  conflictProblem,
  notFoundProblem,
  outOfScopeProblem,
} from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { changedPrintedAssetFields } from './archived-asset-print-dependency';
import { AssetsRepository } from './assets.repository';
import { generateProvisionalAssetCode } from './machine-code';

/** Bounded retry for the astronomically unlikely `code` collision on an auto-generated value. */
const MAX_CODE_GENERATION_ATTEMPTS = 5;

const STATUS_TO_DB: Record<string, 'active' | 'under_repair' | 'decommissioned'> = {
  ACTIVE: 'active',
  UNDER_REPAIR: 'under_repair',
  DECOMMISSIONED: 'decommissioned',
};
const STATUS_FROM_DB: Record<string, 'ACTIVE' | 'UNDER_REPAIR' | 'DECOMMISSIONED'> = {
  active: 'ACTIVE',
  under_repair: 'UNDER_REPAIR',
  decommissioned: 'DECOMMISSIONED',
};

type Row = AssetRow & { assetType?: AssetType };

function toAsset(row: Row): Asset {
  return {
    id: row.id,
    code: row.code,
    assetTypeId: row.assetTypeId,
    assetTypeName: row.assetType?.name,
    description: row.description,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serialNumber,
    areaId: row.areaId,
    locationDetail: row.locationDetail,
    commissionedOn: row.commissionedOn ? row.commissionedOn.toISOString().slice(0, 10) : null,
    scheduleAnchorDate: row.scheduleAnchorDate.toISOString().slice(0, 10),
    status: STATUS_FROM_DB[row.status],
    active: row.active,
    codeProvisional: row.codeProvisional,
  };
}

export interface ListAssetsParams {
  limit?: unknown;
  cursor?: string;
  assetTypeId?: string;
  areaId?: string;
  status?: string;
}

/** PR-020 `asset` — area scoping (PR-API-10) lives in `AssetsRepository`, never re-implemented here. */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AssetsRepository,
    private readonly areaScope: AreaScopeService,
    private readonly audit: AuditEventService,
  ) {}

  async list(userId: string, params: ListAssetsParams): Promise<Page<Asset>> {
    const limit = normaliseLimit(params.limit);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);

    const rows = await this.repo.findMany(
      {
        assetTypeId: params.assetTypeId,
        areaId: params.areaId,
        status: params.status ? STATUS_TO_DB[params.status] : undefined,
        afterId: decodeCursor(params.cursor),
        take: limit + 1,
      },
      allowedAreaIds,
    );

    const page = paginate(rows, limit);
    return { data: page.data.map(toAsset), page: page.page };
  }

  async get(userId: string, id: string): Promise<Asset> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw notFoundProblem('Asset', id);
    }
    await this.assertInScope(userId, row.areaId);
    return toAsset(row);
  }

  async history(userId: string, id: string, params: { limit?: unknown; cursor?: string }) {
    const row = await this.repo.findById(id);
    if (!row) {
      throw notFoundProblem('Asset', id);
    }
    await this.assertInScope(userId, row.areaId);

    // Jobs/records are slice 5/6/7 territory (scheduling, result capture,
    // approval) — this endpoint is real and area-scoping-correct today, it
    // simply has no rows to return yet since nothing generates `job` rows
    // in this slice.
    const limit = normaliseLimit(params.limit);
    return { data: [], page: { nextCursor: null, hasMore: false, limit } };
  }

  /**
   * Slice 13a / B-09: `dto.code` is optional. When the caller supplies one
   * explicitly, it is used as-is and treated as already confirmed
   * (`codeProvisional: false`) — this is the slice-4 behaviour, unchanged.
   * When omitted, a code is auto-generated and flagged `codeProvisional:
   * true` ("RED") until an admin changes it via `update()`. The bounded
   * retry only ever engages on the auto-generated path — an explicit
   * caller-supplied duplicate still fails fast with `conflictProblem`
   * (retrying would silently substitute a DIFFERENT code than the one the
   * caller asked for).
   */
  async create(dto: AssetCreate, actor: ActorMeta): Promise<Asset> {
    const explicitCode = dto.code;
    const maxAttempts = explicitCode ? 1 : MAX_CODE_GENERATION_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const code = explicitCode ?? generateProvisionalAssetCode();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const row = await tx.asset.create({
            data: {
              code,
              codeProvisional: !explicitCode,
              assetTypeId: dto.assetTypeId,
              description: dto.description,
              manufacturer: dto.manufacturer,
              model: dto.model,
              serialNumber: dto.serialNumber,
              areaId: dto.areaId,
              locationDetail: dto.locationDetail,
              commissionedOn: dto.commissionedOn ? new Date(dto.commissionedOn) : undefined,
              scheduleAnchorDate: new Date(dto.scheduleAnchorDate),
            },
            include: { assetType: true },
          });

          await this.audit.record(tx, {
            actorId: actor.actorId,
            action: AuditActionT.create,
            entityType: 'asset',
            entityId: row.id,
            after: toAsset(row),
            sourceIp: actor.sourceIp,
            requestId: actor.requestId,
          });

          return toAsset(row);
        });
      } catch (error) {
        const isCodeCollision =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!isCodeCollision) {
          throw error;
        }
        if (explicitCode || attempt === maxAttempts) {
          throw conflictProblem(`Asset code '${code}' is already in use.`);
        }
        // Auto-generated code collided (astronomically unlikely) — loop and try a fresh one.
      }
    }
    /* istanbul ignore next -- unreachable: the loop always returns or throws */
    throw conflictProblem('Could not generate a unique asset code.');
  }

  async update(userId: string, id: string, dto: AssetUpdate, actor: ActorMeta): Promise<Asset> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw notFoundProblem('Asset', id);
    }
    await this.assertInScope(userId, existing.areaId);

    // Slice 13a / B-09: an admin changing `code` is what CONFIRMS an
    // auto-generated one — clears `codeProvisional` regardless of its
    // current value. Sending the SAME code back is not a "change" (a
    // pass-through PATCH must not spuriously clear a flag nothing altered).
    const codeChanged = dto.code !== undefined && dto.code !== existing.code;

    // INV-09 — refuse an edit that would rewrite what an already-archived,
    // signed record prints. Only `code` and `description` reach the rendered
    // record; every other column on this DTO is untouched by the guard.
    await this.assertNoArchivedRecordDependsOnPrintedFields(existing, dto);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.asset.update({
          where: { id },
          data: {
            code: dto.code,
            codeProvisional: codeChanged ? false : undefined,
            description: dto.description,
            manufacturer: dto.manufacturer,
            model: dto.model,
            // 13-UI-B review B-1: `areaId` is nullable — an explicit `null`
            // CLEARS the assignment (Prisma sets the FK NULL), `undefined`
            // leaves it untouched. Both directions are integration-tested
            // (assets.spec.ts "B-1"); the audit before/after carries the
            // change like any other field.
            areaId: dto.areaId,
            locationDetail: dto.locationDetail,
            status: dto.status ? STATUS_TO_DB[dto.status] : undefined,
            active: dto.active,
          },
          include: { assetType: true },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.update,
          entityType: 'asset',
          entityId: row.id,
          before: toAsset(existing),
          after: toAsset(row),
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return toAsset(row);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem(`Asset code '${dto.code}' is already in use.`);
      }
      throw error;
    }
  }

  /**
   * INV-09 — the archived-record guard for the machine's PRINTED fields.
   *
   * The exposure this closes: `asset.code` and `asset.description` are read
   * live by `pdf-record-assembly.service.ts` (`assetCode`, `machineCode`,
   * `assetDescription`) and a record's PDF is re-rendered from current data on
   * every request — nothing is frozen at archive. So renaming a machine
   * retroactively rewrote three printed fields on EVERY archived record for
   * it, and `GET /records/{id}/integrity` still reported `intact: true`,
   * because the canonical signed record binds `job.assetId` but none of the
   * asset's descriptive columns (`canonical-job-record.ts`).
   *
   * Deliberately NOT a freeze of the machine: the guard looks only at the two
   * columns that actually print, and only when their value changes. A machine
   * with no archived records stays fully editable, `manufacturer`/`model`/
   * `areaId`/`locationDetail`/`status`/`active` are never considered because
   * they do not appear on the record at all, and a no-op re-send is allowed.
   *
   * SCOPE: this guards THIS endpoint. It is not a general immutability
   * property of an archived record's printed content — see
   * `shared/src/template-title.ts` for what that would take.
   */
  private async assertNoArchivedRecordDependsOnPrintedFields(
    existing: AssetRow,
    dto: AssetUpdate,
  ): Promise<void> {
    const changed = changedPrintedAssetFields(
      { code: existing.code, description: existing.description },
      { code: dto.code, description: dto.description },
    );
    if (changed.length === 0) {
      return;
    }

    // Only now is the query worth doing — an edit touching nothing printed
    // never pays for it.
    const archivedJobs = await this.prisma.job.findMany({
      where: { assetId: existing.id, status: JobStatusT.archived },
      select: { jobNumber: true },
      orderBy: { jobNumber: 'asc' },
    });
    if (archivedJobs.length === 0) {
      return;
    }

    throw archivedRecordDependencyProblem({
      subject: changed.map((f) => f.subject).join(' and '),
      change: changed.map((f) => `"${f.before}" would become "${f.after}"`).join('; '),
      pointer: changed[0].pointer,
      blockingJobNumbers: archivedJobs.map((j) => j.jobNumber),
    });
  }

  /** PR-API-10 for by-id reads: exists but out of scope is 403, not a silent 404. */
  private async assertInScope(userId: string, areaId: string | null): Promise<void> {
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    if (allowedAreaIds === null) {
      return;
    }
    if (!areaId || !allowedAreaIds.includes(areaId)) {
      throw outOfScopeProblem('Asset');
    }
  }
}
