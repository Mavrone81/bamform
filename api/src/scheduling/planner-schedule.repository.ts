import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { PrismaService } from '../prisma/prisma.service';

export interface PlannerScheduleFilters {
  /** Inclusive upper bound on `next_due_on` — see the note in `findMany`. */
  dueOnOrBefore: Date;
  areaId?: string;
  assetTypeId?: string;
  afterId?: string;
  take: number;
}

/**
 * Everything one row needs to be drawn AND to be actionable: the machine
 * (grid row header + area), the document (what the visit is), and every
 * sibling rule on that document (what one visit of it carries — the frequency
 * cascade).
 *
 * `scheduleRules` is a nested relation read, NOT a per-row query. Prisma
 * resolves a nested `include` with ONE additional query for the whole page
 * (`WHERE asset_document_id IN (...)`), so a page covering all 76 machines
 * costs a constant handful of statements, not one per machine. That is the
 * difference between this endpoint and the obvious "call
 * `GET /assets/{id}/schedule` 76 times" the screen would otherwise have to do,
 * and it is the reason this endpoint exists at all.
 */
const PLANNER_INCLUDE = {
  assetDocument: {
    include: {
      asset: { select: { id: true, code: true, description: true, areaId: true } },
      formTemplate: { select: { documentNumber: true, title: true } },
      scheduleRules: {
        where: { active: true },
        select: { frequency: true, intervalMonths: true },
      },
    },
  },
} as const;

/** The Prisma row shape. Named `...RuleRow` to stay distinct from
 * `PlannerScheduleRow`, the WIRE shape in `@bamform/shared`. */
export type PlannerScheduleRuleRow = Prisma.ScheduleRuleGetPayload<{
  include: typeof PLANNER_INCLUDE;
}>;

/**
 * Slice 31-PLANNER — the repository for `GET /schedule`, the cross-machine
 * schedule read.
 *
 * THIS FILE IS THE AREA-SCOPE SEAM, exactly as `assets.repository.ts` is for
 * `GET /assets` (PR-API-10 / ADR-005 / API_SPECIFICATION.md §4.2: "scoping is
 * applied in the repository layer, not by callers, so a new endpoint cannot
 * forget it"). There is one read path and it always calls `applyAreaScope`
 * before the query runs; `planner-schedule.service.ts` has no way to issue an
 * unscoped query because it has no Prisma access of its own for this read.
 * `api/test/contract/scope-coverage.spec.ts` pins that this call is still
 * here — it is named in `known-gaps.ts#COLLECTION_ENDPOINTS`.
 *
 * The scoped column is `asset.area_id`, reached through
 * `schedule_rule -> asset_document -> asset`. `schedule_rule` has no `area_id`
 * of its own, the same relationship `GET /jobs` already scopes through
 * (`job.asset.areaId`, see `COLLECTION_ENDPOINTS`), so this is the
 * established shape rather than a new mechanism.
 */
@Injectable()
export class PlannerScheduleRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany(filters: PlannerScheduleFilters, allowedAreaIds: string[] | null) {
    const scopedAsset = applyAreaScope<Prisma.AssetWhereInput>(
      { assetTypeId: filters.assetTypeId },
      allowedAreaIds,
    );

    // An explicit `?areaId=` filter is INTERSECTED with (never allowed to
    // widen) the caller's own scope, character for character the rule
    // `assets.repository.ts#findMany` applies: a scoped planner asking for an
    // area outside their scope gets an empty grid, not an unfiltered one.
    const assetWhere: Prisma.AssetWhereInput = filters.areaId
      ? {
          ...scopedAsset,
          areaId:
            allowedAreaIds === null || allowedAreaIds.includes(filters.areaId)
              ? filters.areaId
              : { in: [] },
        }
      : scopedAsset;

    return this.prisma.scheduleRule.findMany({
      where: {
        // `next_due_on` after the window's end can produce no visit inside it
        // however far it is projected FORWARD, so those rows are excluded in
        // SQL. A rule due BEFORE the window is deliberately kept: projecting
        // it forward is exactly how a monthly rule anchored last year fills
        // this year's grid (`planner-projection.ts`).
        nextDueOn: { lte: filters.dueOnOrBefore },
        // BOTH `active` flags, matching `job-generation.service.ts`'s own
        // `where: { active: true, assetDocument: { active: true } }` exactly —
        // the grid must draw what the scheduler will actually raise, and
        // nothing else. A rule or a document that is retired generates no
        // work (U-SCH-05 as slice 27 extended it), so drawing its visits would
        // show a planner load that never arrives, in the one screen whose
        // entire job is judging how much load a week is carrying.
        //
        // This is a DELIBERATE difference from `asset-schedule.service.ts`,
        // which filters the document only and lets an inactive RULE through so
        // `MachineSchedule` can render it as explicitly "Retired". That screen
        // is a per-machine inventory, where a retired row is information; this
        // one is a forward plan, where it is a phantom. (Currently unreachable
        // either way — no writer in the API sets `schedule_rule.active` false
        // today — which is exactly why it has to be right before one does.)
        active: true,
        assetDocument: { active: true, asset: assetWhere },
        id: filters.afterId ? { gt: filters.afterId } : undefined,
      },
      include: PLANNER_INCLUDE,
      // `id ASC` is the pagination key (PR-API-14: every id is a UUIDv7).
      // The GRID's ordering — machine code down the side — is the screen's
      // business and is applied there; changing this to `assetCode ASC` would
      // break the cursor, which must sort on the same column it seeks by.
      orderBy: { id: 'asc' },
      take: filters.take,
    });
  }
}
