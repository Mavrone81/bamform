import { Injectable } from '@nestjs/common';
import { JobStatusT, type FrequencyT, type Prisma } from '@prisma/client';
import { applyAreaScope } from '../common/area-scope';
import { unassignedJobsForRuleWhere } from '../jobs/rule-unassigned-jobs';
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
      asset: {
        select: {
          id: true,
          code: true,
          description: true,
          areaId: true,
          // Slice 32-PLANNERJOB. The machine family's lead time is what
          // decides when the sweep will raise this rule's job
          // (`job-generation.service.ts` reads exactly this, falling back to
          // the deployment default), and the grid has to say so. Reached
          // through the SAME nested include as everything else on the row —
          // one extra column on a join that already happens, not a new query.
          assetType: { select: { leadTimeDays: true } },
        },
      },
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

  /**
   * ONE rule, with the machine it hangs off — for the two single-entity
   * operations `/schedule/{scheduleRuleId}/…` serves (slice 32-PLANNERJOB).
   *
   * NOT area-scoped here, deliberately, and this is the opposite of a lapse.
   * `findMany` above is a COLLECTION read where an out-of-scope machine must
   * simply be ABSENT; these are single-entity operations on a NAMED rule,
   * where absence would be a 404 that tells the caller the rule does not
   * exist. `AssetScheduleService` already settled that distinction for
   * `GET /assets/{assetId}/schedule` — a named thing outside your scope is a
   * 403 `out-of-scope`, not a lie. The service applies that check to
   * `asset.areaId`, which is why this returns it.
   */
  findRuleForMutation(scheduleRuleId: string) {
    return this.prisma.scheduleRule.findUnique({
      where: { id: scheduleRuleId },
      include: {
        assetDocument: {
          include: { asset: { select: { id: true, code: true, areaId: true } } },
        },
      },
    });
  }

  /**
   * Slice 32-PLANNERJOB — the jobs the scheduler has already raised for the
   * visits on this page, so a planner looking at a due visit can reach the
   * form a technician actually fills.
   *
   * WHY THIS IS MATCHED THE WAY IT IS. The database's own idempotency key is
   * `(asset_document_id, frequency_scope, due_on) WHERE status <> 'voided' AND
   * is_adhoc = false`, and matching a job by anything looser — "the nearest
   * job on this machine", "a job within a few days" — is how a planner ends up
   * opening the wrong record on a machine carrying two documents.
   *
   * `frequency_scope` is NOT reproducible from a `schedule_rule`, though:
   * `JobGenerationService#generateForRule` computes it from the CURRENT
   * template revision's active items and any `standing_content.cascade_override`
   * (`frequency-cascade.ts`), not from the rules on the document, so a revision
   * published after the job was raised would make the two disagree. What IS
   * exact is the rest of what generation writes — `assetDocumentId`,
   * `frequency` and `dueOn`, all copied verbatim off the rule — and
   * `schedule_rule` is `@@unique([asset_document_id, frequency])`, so that
   * tuple names at most one rule and therefore at most one live job for a
   * given due date. It is the same key, reached through the column the
   * schedule can actually vouch for.
   *
   * The two exclusions are the index's own predicate, and both matter here:
   *  - VOIDED (SYS-19): a voided job releases its period so the scheduler
   *    raises a replacement. Linking it would send a planner to dead work and
   *    hide the fact that the live job is still to come.
   *  - AD-HOC (UR-028): created with an EMPTY `frequency_scope`, structurally
   *    incapable of advancing `schedule_rule.next_due_on`. An off-plan
   *    call-out raised on a machine on its PM date must never be presented as
   *    that PM visit's job — the plan would read as covered while the schedule
   *    stayed exactly where it was.
   *
   * AREA SCOPE is applied here too, through `job.asset.areaId` — the same
   * relation `jobs.repository.ts` scopes `GET /jobs` by. Strictly it is
   * redundant (the document ids come from rows this repository has already
   * scoped), but "the caller already filtered" is precisely the assumption
   * ADR-005 exists to stop anyone making: this file is the area-scope seam for
   * `GET /schedule`, and every read in it applies the scope itself.
   */
  findScheduledJobsForVisits(
    visits: readonly VisitKey[],
    allowedAreaIds: string[] | null,
  ): Promise<ScheduledVisitJobRow[]> {
    if (visits.length === 0) {
      return Promise.resolve([]);
    }

    return this.prisma.job.findMany({
      where: {
        isAdhoc: false,
        status: { not: JobStatusT.voided },
        asset: applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds),
        OR: visits.map((visit) => ({
          assetDocumentId: visit.assetDocumentId,
          frequency: visit.frequency,
          dueOn: visit.dueOn,
        })),
      },
      select: JOB_VISIT_SELECT,
      // Deterministic: if a schema change ever allowed two live jobs on one
      // key, the grid must pick the same one on every read rather than
      // whichever the planner happened to return.
      orderBy: { generatedAt: 'asc' },
    });
  }

  /** See `RuleJobSelection` — how many jobs the offer may honestly claim. */
  countUnassignedJobsForRule(
    rule: RuleJobSelection,
    allowedAreaIds: string[] | null,
  ): Promise<number> {
    return this.prisma.job.count({
      where: {
        ...unassignedJobsForRuleWhere(rule),
        asset: applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds),
      },
    });
  }

  /**
   * See `RuleJobSelection` — the jobs the confirmation will actually walk.
   *
   * `take` is one MORE than the batch cap at the caller's request, so it can
   * tell "exactly the cap" from "more than the cap" without a second count and
   * report `notAttempted` honestly. Ordered by due date so a partial
   * application takes the most overdue work first, which is the order a
   * planner would have done it by hand.
   */
  findUnassignedJobsForRule(
    rule: RuleJobSelection,
    allowedAreaIds: string[] | null,
    take: number,
  ): Promise<RuleUnassignedJobRow[]> {
    return this.prisma.job.findMany({
      where: {
        ...unassignedJobsForRuleWhere(rule),
        asset: applyAreaScope<Prisma.AssetWhereInput>({}, allowedAreaIds),
      },
      select: RULE_UNASSIGNED_JOB_SELECT,
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      take,
    });
  }
}

/**
 * Slice 33-APPLYDEFAULT — the jobs a rule has ALREADY raised that its standing
 * assignee could still be applied to, and how many there are.
 *
 * TWO METHODS, ONE `where`. The count is what the planner is shown after
 * setting a standing assignee ("4 unassigned jobs already exist for this
 * plan"); the list is what the confirmation actually iterates. Both take their
 * filter from `rule-unassigned-jobs.ts#unassignedJobsForRuleWhere`, so the
 * number offered is by construction the number attempted — see that module for
 * why each exclusion is there.
 *
 * DIFFERENT FROM `findScheduledJobsForVisits` ABOVE, and deliberately: that
 * one is keyed on `dueOn` too, because it answers "the job for THIS visit".
 * This answers "every job this plan still owns", across due dates — a rule
 * whose visits were missed can be carrying more than one.
 *
 * AREA SCOPE IS APPLIED HERE, as it is on every read in this file. Strictly
 * redundant (the caller has already resolved the rule through
 * `findRuleForMutation` and checked its machine), but ADR-005 puts the scope
 * in the repository precisely so no read has to rely on a caller having done
 * it — and this one feeds a WRITE, where a missing scope would not merely leak
 * a row but hand somebody else's machine to somebody else's technician.
 */
export interface RuleJobSelection {
  assetDocumentId: string;
  frequency: FrequencyT;
}

const RULE_UNASSIGNED_JOB_SELECT = {
  id: true,
  jobNumber: true,
  status: true,
  dueOn: true,
} as const;

export type RuleUnassignedJobRow = Prisma.JobGetPayload<{
  select: typeof RULE_UNASSIGNED_JOB_SELECT;
}>;

/** The tuple that names one visit's job — see `findScheduledJobsForVisits`. */
export interface VisitKey {
  assetDocumentId: string;
  frequency: FrequencyT;
  dueOn: Date;
}

/**
 * Everything the planner grid needs about a visit's job: the handle
 * (id/number/status), the key it was matched on, and WHO is responsible.
 *
 * `assignee` is the encrypted-name columns only. `app_user.full_name` is
 * application-layer encrypted (DBD §6.2) and the planner service decrypts it
 * through the same `decodeIdentityField` helper `users.mapper.ts` uses —
 * NOTHING else about the user is selected, so this read cannot become a side
 * door onto the directory `GET /users` gates to ADMIN.
 */
const JOB_VISIT_SELECT = {
  id: true,
  jobNumber: true,
  status: true,
  assetDocumentId: true,
  frequency: true,
  dueOn: true,
  generatedAt: true,
  assignedTo: true,
  assignee: { select: { id: true, fullNameCt: true, dekVersion: true } },
} as const;

export type ScheduledVisitJobRow = Prisma.JobGetPayload<{ select: typeof JOB_VISIT_SELECT }>;
