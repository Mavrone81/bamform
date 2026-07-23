import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditActionT, Prisma, RevisionStatusT, type PrismaClient } from '@prisma/client';
import type {
  CreateRevisionRequest,
  PatchRevisionRequest,
  RejectRevisionRequest,
  ReplaceItemsRequest,
  ReplaceMeasurementsRequest,
  TemplateItem,
  TemplateMeasurement,
  TemplateRevision,
} from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import type { ActorMeta } from '../common/actor-meta';
import {
  conflictProblem,
  notFoundProblem,
  revisionSequenceGapProblem,
  selfApprovalProblem,
  specLimitsInvertedProblem,
} from '../common/domain-problems';
import { PrismaService } from '../prisma/prisma.service';
import {
  SPEC_TYPE_TO_DB,
  toTemplateItem,
  toTemplateMeasurement,
  toTemplateRevision,
} from './mappers';
import {
  assertDraft,
  assertNotSelfApproval,
  assertPendingApproval,
  nextSequenceOrdinal,
} from './revision-transitions';

type Tx = Prisma.TransactionClient | PrismaClient;

const REVISION_INCLUDE = {
  formTemplate: true,
  items: { orderBy: { displayOrder: 'asc' as const } },
  measurements: { orderBy: { displayOrder: 'asc' as const } },
};

/**
 * Template revision lifecycle — PRD §5.2, PR-022..028, PR-047..049.
 *
 * DB-first invariants (INV-01..04) are enforced by slice-1's triggers/
 * constraints; this service pre-checks the common case for a clean error
 * (`revision-transitions.ts`) and additionally catches the DB's own
 * rejection on a genuine race as a backstop — see the `catch` blocks below.
 *
 * KNOWN LIMITATION (flagged in slice-4-report.md): `replaceItems`/
 * `replaceMeasurements` are documented as "replace wholesale"
 * (API_SPECIFICATION.md §10.4 / `openapi.yaml`'s `replaceRevisionMeasurements`),
 * but `bamform_app` holds NO `DELETE` grant on any table (non-negotiable #7,
 * `grants.sql`, INV-16) — a literal delete-then-recreate is not possible
 * without violating that non-negotiable. Both are implemented as an
 * upsert-by-`stableKey` instead: existing rows are updated in place, new
 * `stableKey`s are inserted, and a shrinking edit (removing an item/
 * measurement from a draft) cannot remove its row — the stale row remains
 * attached to the revision. This only affects DRAFT content that has never
 * been current/bound to a job. Recommended follow-up: an additive migration
 * giving `template_item`/`template_measurement` a `superseded`/`active` flag.
 */
@Injectable()
export class RevisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async listForTemplate(templateId: string): Promise<TemplateRevision[]> {
    const template = await this.prisma.formTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      throw notFoundProblem('Form template', templateId);
    }
    const rows = await this.prisma.templateRevision.findMany({
      where: { formTemplateId: templateId },
      include: REVISION_INCLUDE,
      orderBy: { sequenceOrdinal: 'desc' },
    });
    return rows.map((row) => toTemplateRevision(row));
  }

  async get(id: string): Promise<TemplateRevision> {
    const row = await this.prisma.templateRevision.findUnique({
      where: { id },
      include: REVISION_INCLUDE,
    });
    if (!row) {
      throw notFoundProblem('Template revision', id);
    }
    return toTemplateRevision(row);
  }

  async create(
    templateId: string,
    dto: CreateRevisionRequest,
    actor: ActorMeta,
  ): Promise<TemplateRevision> {
    const template = await this.prisma.formTemplate.findUnique({ where: { id: templateId } });
    if (!template) {
      throw notFoundProblem('Form template', templateId);
    }

    const current = await this.prisma.templateRevision.findFirst({
      where: { formTemplateId: templateId, status: RevisionStatusT.current },
      include: { items: true, measurements: true },
    });
    const maxOrdinal = await this.prisma.templateRevision.aggregate({
      where: { formTemplateId: templateId },
      _max: { sequenceOrdinal: true },
    });
    const sequenceOrdinal = nextSequenceOrdinal(maxOrdinal._max.sequenceOrdinal);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.templateRevision.create({
          data: {
            formTemplateId: templateId,
            revisionCode: dto.revisionCode,
            sequenceOrdinal,
            status: RevisionStatusT.draft,
            changeDescription: dto.changeDescription,
            standingContent: (current?.standingContent ?? {}) as Prisma.InputJsonValue,
            authoredBy: actor.actorId,
            authoredAt: new Date(),
          },
        });

        if (current?.items.length) {
          await tx.templateItem.createMany({
            data: current.items.map((item) => ({
              templateRevisionId: created.id,
              itemNo: item.itemNo,
              frequency: item.frequency,
              instruction: item.instruction,
              mandatory: item.mandatory,
              stableKey: item.stableKey,
              displayOrder: item.displayOrder,
            })),
          });
        }
        if (current?.measurements.length) {
          await tx.templateMeasurement.createMany({
            data: current.measurements.map((m) => ({
              templateRevisionId: created.id,
              section: m.section,
              description: m.description,
              unit: m.unit,
              specType: m.specType,
              lowerLimit: m.lowerLimit,
              upperLimit: m.upperLimit,
              nominal: m.nominal,
              tolerance: m.tolerance,
              specDisplay: m.specDisplay,
              stableKey: m.stableKey,
              displayOrder: m.displayOrder,
            })),
          });
        }

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.create,
          entityType: 'template_revision',
          entityId: created.id,
          after: { revisionCode: created.revisionCode, sequenceOrdinal: created.sequenceOrdinal },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return this.loadFull(tx, created.id);
      });
    } catch (error) {
      throw this.translateSequenceError(error);
    }
  }

  async patch(id: string, dto: PatchRevisionRequest, actor: ActorMeta): Promise<TemplateRevision> {
    const existing = await this.requireRevision(id);
    assertDraft(existing.status);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.templateRevision.update({
        where: { id },
        data: {
          revisionCode: dto.revisionCode,
          changeDescription: dto.changeDescription,
          standingContent: dto.standingContent as Prisma.InputJsonValue | undefined,
        },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'template_revision',
        entityId: row.id,
        before: { changeDescription: existing.changeDescription },
        after: { changeDescription: row.changeDescription },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return this.loadFull(tx, id);
    });
  }

  async replaceItems(
    id: string,
    dto: ReplaceItemsRequest,
    actor: ActorMeta,
  ): Promise<TemplateItem[]> {
    const existing = await this.requireRevision(id);
    assertDraft(existing.status);

    return this.prisma.$transaction(async (tx) => {
      const currentItems = await tx.templateItem.findMany({ where: { templateRevisionId: id } });
      const byStableKey = new Map(currentItems.map((item) => [item.stableKey, item]));

      for (const [index, item] of dto.entries()) {
        const stableKey = item.stableKey ?? randomUUID();
        const existingItem = byStableKey.get(stableKey);
        const data = {
          itemNo: item.itemNo,
          frequency: item.frequency,
          instruction: item.instruction,
          mandatory: item.mandatory ?? true,
          displayOrder: item.displayOrder ?? index,
        };

        if (existingItem) {
          await tx.templateItem.update({ where: { id: existingItem.id }, data });
        } else {
          await tx.templateItem.create({
            data: { ...data, templateRevisionId: id, stableKey },
          });
        }
      }

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'template_revision',
        entityId: id,
        after: { itemsReplaced: dto.length },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      const rows = await tx.templateItem.findMany({
        where: { templateRevisionId: id },
        orderBy: { displayOrder: 'asc' },
      });
      return rows.map(toTemplateItem);
    });
  }

  async replaceMeasurements(
    id: string,
    dto: ReplaceMeasurementsRequest,
    actor: ActorMeta,
  ): Promise<TemplateMeasurement[]> {
    const existing = await this.requireRevision(id);
    assertDraft(existing.status);

    dto.forEach((m, index) => {
      if (m.lowerLimit != null && m.upperLimit != null && m.lowerLimit > m.upperLimit) {
        throw specLimitsInvertedProblem(`/${index}`);
      }
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const currentMeasurements = await tx.templateMeasurement.findMany({
          where: { templateRevisionId: id },
        });
        const byStableKey = new Map(currentMeasurements.map((m) => [m.stableKey, m]));

        for (const [index, m] of dto.entries()) {
          const existingMeasurement = byStableKey.get(m.stableKey);
          const data = {
            section: m.section,
            description: m.description,
            unit: m.unit,
            specType: SPEC_TYPE_TO_DB[m.specType],
            lowerLimit: m.lowerLimit ?? null,
            upperLimit: m.upperLimit ?? null,
            nominal: m.nominal ?? null,
            tolerance: m.tolerance ?? null,
            specDisplay: m.specDisplay,
            displayOrder: m.displayOrder ?? index,
          };

          if (existingMeasurement) {
            await tx.templateMeasurement.update({ where: { id: existingMeasurement.id }, data });
          } else {
            await tx.templateMeasurement.create({
              data: { ...data, templateRevisionId: id, stableKey: m.stableKey },
            });
          }
        }

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.update,
          entityType: 'template_revision',
          entityId: id,
          after: { measurementsReplaced: dto.length },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        const rows = await tx.templateMeasurement.findMany({
          where: { templateRevisionId: id },
          orderBy: { displayOrder: 'asc' },
        });
        return rows.map(toTemplateMeasurement);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientUnknownRequestError &&
        error.message.includes('template_measurement_limits_ordered_chk')
      ) {
        throw specLimitsInvertedProblem('/');
      }
      throw error;
    }
  }

  async submit(id: string, actor: ActorMeta): Promise<TemplateRevision> {
    const existing = await this.requireRevision(id);
    assertDraft(existing.status);

    return this.prisma.$transaction(async (tx) => {
      await tx.templateRevision.update({
        where: { id },
        data: { status: RevisionStatusT.pending_approval, submittedAt: new Date() },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.state_change,
        entityType: 'template_revision',
        entityId: id,
        before: { status: 'DRAFT' },
        after: { status: 'PENDING_APPROVAL' },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return this.loadFull(tx, id);
    });
  }

  /**
   * PR-047/INV-03 (self-approval rejected in service AND DB) + PR-048
   * (supersede-in-same-transaction) + PR-049 (in-flight jobs never rebound —
   * achieved simply by never touching `job.template_revision_id` here).
   */
  async approve(id: string, actor: ActorMeta): Promise<TemplateRevision> {
    const existing = await this.requireRevision(id);
    assertPendingApproval(existing.status);
    assertNotSelfApproval(existing.authoredBy, actor.actorId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const previousCurrent = await tx.templateRevision.findFirst({
          where: { formTemplateId: existing.formTemplateId, status: RevisionStatusT.current },
        });

        const now = new Date();

        // Supersede the previous CURRENT FIRST, in the same transaction —
        // by the time the next statement promotes this revision, the
        // partial-unique "one current per template" index (INV-01) no
        // longer has a conflicting row to trip over in the normal
        // single-writer path (it remains the backstop for a genuine
        // concurrent-transaction race).
        if (previousCurrent) {
          await tx.templateRevision.update({
            where: { id: previousCurrent.id },
            data: { status: RevisionStatusT.superseded, supersededAt: now },
          });
        }

        await tx.templateRevision.update({
          where: { id },
          data: {
            status: RevisionStatusT.current,
            approvedBy: actor.actorId,
            approvedAt: now,
            effectiveFrom: now,
          },
        });

        await this.audit.record(tx, {
          actorId: actor.actorId,
          action: AuditActionT.approve,
          entityType: 'template_revision',
          entityId: id,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'CURRENT', supersededRevisionId: previousCurrent?.id ?? null },
          sourceIp: actor.sourceIp,
          requestId: actor.requestId,
        });

        return this.loadFull(tx, id);
      });
    } catch (error) {
      // Backstop only — the pre-checks above already prevent both cases in
      // the normal single-writer path; these branches exist for a genuine
      // concurrent-transaction race (DBD §7 INV-03's stated mechanism).
      if (
        error instanceof Prisma.PrismaClientUnknownRequestError &&
        error.message.includes('template_revision_approver_not_author_chk')
      ) {
        throw selfApprovalProblem('You authored this revision and cannot approve your own work.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflictProblem(
          'Another revision for this template was approved concurrently. Reload and retry.',
        );
      }
      throw error;
    }
  }

  async reject(
    id: string,
    dto: RejectRevisionRequest,
    actor: ActorMeta,
  ): Promise<TemplateRevision> {
    const existing = await this.requireRevision(id);
    assertPendingApproval(existing.status);

    return this.prisma.$transaction(async (tx) => {
      await tx.templateRevision.update({
        where: { id },
        data: { status: RevisionStatusT.rejected, rejectedReason: dto.reason },
      });

      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.reject,
        entityType: 'template_revision',
        entityId: id,
        before: { status: 'PENDING_APPROVAL' },
        after: { status: 'REJECTED', rejectedReason: dto.reason },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });

      return this.loadFull(tx, id);
    });
  }

  private async requireRevision(id: string) {
    const row = await this.prisma.templateRevision.findUnique({ where: { id } });
    if (!row) {
      throw notFoundProblem('Template revision', id);
    }
    return row;
  }

  private async loadFull(tx: Tx, id: string): Promise<TemplateRevision> {
    const row = await tx.templateRevision.findUniqueOrThrow({
      where: { id },
      include: REVISION_INCLUDE,
    });
    return toTemplateRevision(row);
  }

  private translateSequenceError(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return revisionSequenceGapProblem();
    }
    if (
      error instanceof Prisma.PrismaClientUnknownRequestError &&
      error.message.includes('must be contiguous')
    ) {
      return revisionSequenceGapProblem();
    }
    return error;
  }
}
