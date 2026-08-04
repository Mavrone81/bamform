import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActionT } from '@prisma/client';
import {
  resolveTemplateTitle,
  type PlannerDefaultAssignee,
  type PlannerScheduleQuery,
  type PlannerScheduleRow,
  type PlannerVisitJob,
  type SetDefaultAssigneeRequest,
  type SetDefaultAssigneeResult,
} from '@bamform/shared';
import { AuditEventService } from '../audit/audit-event.service';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import type { ActorMeta } from '../common/actor-meta';
import { AreaScopeService } from '../common/area-scope';
import {
  notFoundProblem,
  outOfScopeProblem,
  validationFailedProblem,
} from '../common/domain-problems';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import {
  AssignableUserService,
  eligibilityKey,
  type AssigneeEligibility,
} from '../jobs/assignable-user.service';
import { JOB_ASSIGNMENT_ROLES } from '../jobs/job-access';
import { PrismaService } from '../prisma/prisma.service';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { JOB_STATUS_FROM_DB } from '../jobs/job-enums';
import { resolveCascadeFrequencyScope } from './frequency-cascade';
import { jobGenerationOpensOn, resolveDefaultLeadTimeDays } from './job-generation.service';
import { parseIsoDateOnly, projectVisitDates, toIsoDateOnly } from './planner-projection';
import {
  PlannerScheduleRepository,
  type PlannerScheduleRuleRow,
  type ScheduledVisitJobRow,
} from './planner-schedule.repository';

/**
 * The longest window one request may ask for. `MAX_PROJECTED_VISITS_PER_RULE`
 * already bounds a single row; this bounds the response as a whole, so a
 * `?to=2999-12-31` cannot ask the server to project a thousand years of
 * monthly visits for every machine in the plant. Five years is well past any
 * real planning horizon (the artefact being replaced covers one year) while
 * leaving room to look at next year alongside this one.
 */
const MAX_WINDOW_DAYS = 366 * 5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Slice 31-PLANNER — `GET /schedule`, the cross-machine schedule read.
 *
 * The scoping, the role convention and the envelope are all deliberately
 * INHERITED rather than decided afresh:
 *
 *  - AREA SCOPING lives in `PlannerScheduleRepository`, which always calls
 *    `applyAreaScope`. This service never queries `schedule_rule` itself.
 *    Unlike `AssetScheduleService`, which reads ONE named asset and therefore
 *    answers 403 `/errors/out-of-scope` for a machine the caller cannot see,
 *    this is a COLLECTION read: an out-of-scope machine is simply absent, the
 *    same way it is absent from `GET /assets`. (Refusing the whole grid
 *    because the plant contains a machine the caller cannot see would make
 *    the endpoint useless to exactly the scoped planners it is for.)
 *
 *  - NO `@Roles()` on the controller, matching `GET /assets/{id}/schedule`
 *    exactly. See the controller for why.
 *
 *  - THE PAGE ENVELOPE is the standard cursor page (PR-API-14/15).
 *    `GET /assets/{id}/schedule` returns a BARE ARRAY because it is
 *    fixed-cardinality for one already-scope-checked asset; this is a
 *    tenant-wide collection, where that would be a new and unpaginated shape.
 *
 * WHAT THIS DOES ON TOP OF THE ROWS: projects each rule across the window
 * (`planner-projection.ts`) and resolves what one visit of it carries
 * (`frequency-cascade.ts`). Both are server-side deliberately — they are
 * existing scheduling arithmetic, and re-deriving them in the web app and the
 * Android shell would be two more places for the plan to disagree with the
 * scheduler.
 */
@Injectable()
export class PlannerScheduleService {
  private readonly logger = new Logger(PlannerScheduleService.name);

  constructor(
    private readonly repo: PlannerScheduleRepository,
    private readonly areaScope: AreaScopeService,
    private readonly config: ConfigService,
    /**
     * Slice 32-PLANNERJOB. Used for ONE field: the assignee's name on a visit
     * that actually has a job (`app_user.full_name` is application-layer
     * encrypted, DBD §6.2). An id names nobody, and "due, and nobody has it"
     * is the state this screen exists to surface — but the decryption is kept
     * to the single column, on the small subset of rows whose job has been
     * raised, and never becomes a directory read.
     */
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
    /**
     * Slice 32-PLANNERJOB. The SAME rule `POST /jobs/{jobId}/assign` enforces
     * — shared rather than restated, because a planner told "yes" when
     * setting a standing assignee and "no" when the job appears would have no
     * way to reconcile the two.
     */
    private readonly assignableUsers: AssignableUserService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(
    userId: string,
    roles: string[],
    query: PlannerScheduleQuery,
  ): Promise<Page<PlannerScheduleRow>> {
    const { from, to } = resolveWindow(query);
    const limit = normaliseLimit(query.limit);
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);

    const rows = await this.repo.findMany(
      {
        dueOnOrBefore: to,
        areaId: query.areaId,
        assetTypeId: query.assetTypeId,
        afterId: decodeCursor(query.cursor),
        take: limit + 1,
      },
      allowedAreaIds,
    );

    const page = paginate(rows, limit);

    // Slice 32-PLANNERJOB. ONE additional query for the whole page, issued
    // after `paginate` has dropped the look-ahead row so it never asks about a
    // visit the caller will not be shown. Resolving the job per row would be
    // the "call `GET /jobs` 230 times" shape this endpoint exists to avoid.
    const defaultLeadTimeDays = resolveDefaultLeadTimeDays(
      this.config.get('DEFAULT_LEAD_TIME_DAYS'),
    );
    const jobs = await this.repo.findScheduledJobsForVisits(
      page.data.map((row) => ({
        assetDocumentId: row.assetDocumentId,
        frequency: row.frequency,
        dueOn: row.nextDueOn,
      })),
      allowedAreaIds,
    );
    const jobByVisit = indexJobsByVisit(jobs);

    /*
     * WHETHER THIS CALLER SEES NAMES — review finding.
     *
     * This endpoint carries no `@Roles()` and must not gain one: every
     * authenticated user could already read these schedule rows one machine at
     * a time through `GET /assets/{id}/schedule`, and slice 18's governing
     * rule is "ADD, never remove". But the NAMES are new, and they are a
     * different kind of thing from a due date — `GET /users` is ADMIN-only,
     * the picker twenty lines away in this controller refuses AUDITOR and
     * DOC_CONTROLLER outright, and `jobs/mappers.ts` deliberately omits
     * `assignedToName` from every job read on exactly this reasoning.
     *
     * So the row stays readable by everyone and the name is withheld from
     * anyone who cannot act on assignment. The ids remain, so a caller can
     * still tell "nobody is assigned" from "a name you are not shown".
     */
    const maySeeNames = roles.some((role) => JOB_ASSIGNMENT_ROLES.includes(role));

    // Slice 32-PLANNERJOB — the STANDING assignee, and whether they would
    // still be accepted for that machine today. One batched query for the
    // whole page (`resolveEligibility`), never one per row: the grid draws 230
    // rules and the answer must not cost 230 round trips.
    const eligibility = await this.assignableUsers.resolveEligibility(
      page.data
        .filter((row) => row.defaultAssigneeId !== null)
        .map((row) => ({
          userId: row.defaultAssigneeId as string,
          areaId: row.assetDocument.asset.areaId,
        })),
    );

    return {
      data: page.data.map((row) =>
        toPlannerRow(
          row,
          from,
          to,
          defaultLeadTimeDays,
          jobByVisit.get(visitKeyOf(row)) ?? null,
          (job) => (maySeeNames ? this.assigneeName(job) : null),
          row.defaultAssigneeId
            ? (eligibility.get(
                eligibilityKey(row.defaultAssigneeId, row.assetDocument.asset.areaId),
              ) ?? null)
            : null,
          maySeeNames,
        ),
      ),
      page: page.page,
    };
  }

  /**
   * `GET /schedule/{scheduleRuleId}/assignable-users` — slice 32-PLANNERJOB.
   *
   * ONE PICKER FOR BOTH LEVELS, and that is the point rather than a
   * convenience. The standing assignee on a rule and the assignee on a job
   * generated from it are judged against the SAME machine's area, so the
   * candidate sets are identical by construction. Two endpoints would have
   * been two lists that could disagree, and a planner switching between "who
   * normally does this" and "who does this one" would have had no way to tell
   * which list they were looking at.
   *
   * KEYED BY THE RULE, not the job, for the same reason: the rule exists
   * before the job does. A visit whose job has not been generated yet still
   * needs a picker, and the planner is the screen where both are set.
   *
   * WHY IT EXISTS AT ALL: `GET /users` is `@Roles('ADMIN')`, so PLANNER,
   * TEAM_LEADER and ENGINEER — three of the four roles that MAY assign — had
   * no readable source for the list. Widening `/users` would have handed them
   * the whole directory including email and employee id; this hands them a
   * name and the roles that put the person on the list, for one machine they
   * can already see.
   */
  async listAssignableUsers(
    userId: string,
    scheduleRuleId: string,
    query: { limit?: unknown; cursor?: string },
  ): Promise<Page<import('@bamform/shared').AssignableUser>> {
    const rule = await this.loadRuleInScope(userId, scheduleRuleId);
    return this.assignableUsers.list(rule.assetDocument.asset.areaId, query);
  }

  /**
   * `PUT /schedule/{scheduleRuleId}/default-assignee` — slice 32-PLANNERJOB.
   * Sets (or clears, with `null`) WHO NORMALLY DOES THIS PM.
   *
   * IT WRITES ONE COLUMN AND TOUCHES NO JOB. That is the whole contract:
   * `schedule_rule.default_assignee_id` is read by `JobGenerationService` when
   * it CREATES a job, so this affects work not yet generated and nothing else.
   * A job already raised keeps whoever it has — including one raised five
   * minutes ago — and the planner is told so, because a control that silently
   * moved work already in progress would be a different and much worse
   * feature.
   *
   * VALIDATED WITH THE SAME RULE AS `POST /jobs/{jobId}/assign`, against this
   * machine's area. It is validated again at generation time, because
   * eligibility lapses between the two and this endpoint cannot promise
   * otherwise — see `JobGenerationService#resolveDefaultAssignee`.
   */
  async setDefaultAssignee(
    actor: ActorMeta,
    scheduleRuleId: string,
    dto: SetDefaultAssigneeRequest,
  ): Promise<SetDefaultAssigneeResult> {
    const rule = await this.loadRuleInScope(actor.actorId, scheduleRuleId);
    const areaId = rule.assetDocument.asset.areaId;

    if (dto.defaultAssigneeId) {
      // 422 naming which of the three conditions failed — the shared check,
      // not a second copy of it.
      await this.assignableUsers.assertAssignable(dto.defaultAssigneeId, areaId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.scheduleRule.update({
        where: { id: scheduleRuleId },
        data: { defaultAssigneeId: dto.defaultAssigneeId },
      });
      await this.audit.record(tx, {
        actorId: actor.actorId,
        action: AuditActionT.update,
        entityType: 'schedule_rule',
        entityId: scheduleRuleId,
        // Ids only. `app_user.full_name` is encrypted and `audit_event` is
        // append-only with 7-year retention, so writing a decrypted name here
        // would be a permanent plaintext copy (PR-SEC-02, and the same reason
        // `users.mapper.ts#toUserAuditView` exists).
        before: { defaultAssigneeId: rule.defaultAssigneeId },
        after: { defaultAssigneeId: dto.defaultAssigneeId },
        sourceIp: actor.sourceIp,
        requestId: actor.requestId,
      });
    });

    if (!dto.defaultAssigneeId) {
      return { scheduleRuleId, defaultAssignee: null };
    }
    const resolved = await this.assignableUsers.resolveEligibility([
      { userId: dto.defaultAssigneeId, areaId },
    ]);
    const entry = resolved.get(eligibilityKey(dto.defaultAssigneeId, areaId));
    return {
      scheduleRuleId,
      defaultAssignee: entry
        ? { id: dto.defaultAssigneeId, fullName: entry.fullName, eligibility: entry.verdict }
        : null,
    };
  }

  /**
   * A NAMED rule the caller may act on: 404 when it does not exist, 403
   * `out-of-scope` when its machine is outside the caller's area scope.
   *
   * Deliberately NOT the collection behaviour of `list` above. There, an
   * out-of-scope machine is simply absent — refusing a whole grid over one
   * invisible machine would make the endpoint useless. Here the caller has
   * NAMED a rule, and answering 404 for one that exists would be a lie;
   * `AssetScheduleService` already settled this distinction for
   * `GET /assets/{assetId}/schedule`.
   */
  private async loadRuleInScope(userId: string, scheduleRuleId: string) {
    const rule = await this.repo.findRuleForMutation(scheduleRuleId);
    if (!rule) {
      throw notFoundProblem('ScheduleRule', scheduleRuleId);
    }
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
    const areaId = rule.assetDocument.asset.areaId;
    if (allowedAreaIds !== null && (!areaId || !allowedAreaIds.includes(areaId))) {
      throw outOfScopeProblem('Asset');
    }
    return rule;
  }

  /**
   * PER-ROW RESCUE — review finding, same rule as
   * `assignable-user.service.ts#nameOf`. One undecryptable `app_user` row must
   * not 500 the whole year's plan for every planner; it degrades to the id,
   * which names nobody but is true and is something an admin can look up.
   */
  private assigneeName(job: ScheduledVisitJobRow): string | null {
    if (!job.assignee) return null;
    try {
      return decodeIdentityField(
        job.assignee.fullNameCt,
        job.assignee.dekVersion,
        { column: 'full_name_ct', rowId: job.assignee.id },
        this.fieldEncryption,
      );
    } catch (error) {
      this.logger.error(
        `could not decrypt the assignee name for job ${job.id} (user ${job.assignee.id}): ` +
          `${(error as Error)?.message ?? String(error)}. Reporting the id in its place.`,
      );
      return job.assignee.id;
    }
  }
}

/**
 * The visit key as a string, so the page's jobs can be joined to its rows in
 * memory. `dueOn` is reduced to its calendar date on both sides — `due_on` and
 * `next_due_on` are DATE columns, but Prisma hands them back as `Date`s whose
 * `getTime()` would compare unequal if either ever carried a time-of-day.
 */
function visitKeyOf(row: { assetDocumentId: string; frequency: string; nextDueOn: Date }): string {
  return `${row.assetDocumentId}|${row.frequency}|${toIsoDateOnly(row.nextDueOn)}`;
}

function indexJobsByVisit(
  jobs: readonly ScheduledVisitJobRow[],
): Map<string, ScheduledVisitJobRow> {
  const byVisit = new Map<string, ScheduledVisitJobRow>();
  for (const job of jobs) {
    const key = `${job.assetDocumentId}|${job.frequency}|${toIsoDateOnly(job.dueOn)}`;
    // FIRST wins. The repository orders by `generatedAt asc` and the partial
    // unique index makes a second live job on one key impossible today; if a
    // future schema change made it possible, the grid must still be stable
    // read to read rather than silently swapping which job it links.
    if (!byVisit.has(key)) byVisit.set(key, job);
  }
  return byVisit;
}

/**
 * The window. Both bounds default to the current CALENDAR year because work
 * week 1 starts 1 January (the plant's own convention — see
 * `web/src/lib/work-week.ts`), so an omitted window is exactly one
 * spreadsheet's worth of plan.
 *
 * A malformed or inverted window is REFUSED rather than quietly defaulted: a
 * planner who mistyped a year and silently got this year's grid back would
 * have no way to tell, and would plan against the wrong twelve months.
 */
function resolveWindow(query: PlannerScheduleQuery): { from: Date; to: Date } {
  const currentYear = new Date().getUTCFullYear();
  const from = query.from ? parseIsoDateOnly(query.from) : new Date(Date.UTC(currentYear, 0, 1));
  const to = query.to ? parseIsoDateOnly(query.to) : new Date(Date.UTC(currentYear, 11, 31));

  if (!from) {
    throw validationFailedProblem(
      `\`from\` must be a calendar date as YYYY-MM-DD (got '${query.from}').`,
    );
  }
  if (!to) {
    throw validationFailedProblem(
      `\`to\` must be a calendar date as YYYY-MM-DD (got '${query.to}').`,
    );
  }
  if (to.getTime() < from.getTime()) {
    throw validationFailedProblem(
      `\`to\` (${toIsoDateOnly(to)}) is before \`from\` (${toIsoDateOnly(from)}) — the window is empty.`,
    );
  }
  const days = (to.getTime() - from.getTime()) / MS_PER_DAY;
  if (days > MAX_WINDOW_DAYS) {
    throw validationFailedProblem(
      `The planning window may span at most ${MAX_WINDOW_DAYS} days; this one spans ${Math.round(days)}.`,
    );
  }
  return { from, to };
}

function toPlannerRow(
  row: PlannerScheduleRuleRow,
  from: Date,
  to: Date,
  defaultLeadTimeDays: number,
  job: ScheduledVisitJobRow | null,
  assigneeName: (job: ScheduledVisitJobRow) => string | null,
  defaultAssignee: AssigneeEligibility | null,
  maySeeNames: boolean,
): PlannerScheduleRow {
  const asset = row.assetDocument.asset;
  const template = row.assetDocument.formTemplate;

  // Exactly what `JobGenerationService#generateDueJobs` reads: the machine
  // family's own lead time, or the deployment default where it sets none.
  const leadTimeDays = asset.assetType.leadTimeDays ?? defaultLeadTimeDays;

  return {
    id: row.id,
    assetId: asset.id,
    assetCode: asset.code,
    assetDescription: asset.description,
    areaId: asset.areaId,

    assetDocumentId: row.assetDocumentId,
    documentNumber: template.documentNumber,
    // Resolved exactly the way `asset-documents.service.ts#toDto` resolves it
    // — same helper, same inputs. A title is never stored resolved.
    documentTitle: resolveTemplateTitle(template.title, row.assetDocument.machineNumber),

    frequency: row.frequency as unknown as PlannerScheduleRow['frequency'],
    intervalMonths: row.intervalMonths,
    nextDueOn: toIsoDateOnly(row.nextDueOn),
    lastCompletedOn: row.lastCompletedOn ? toIsoDateOnly(row.lastCompletedOn) : null,
    adjustedReason: row.adjustedReason,
    active: row.active,

    plannedDates: projectVisitDates(row.nextDueOn, row.intervalMonths, from, to).map(toIsoDateOnly),

    // Computed from the rules that ACTUALLY exist on this document, not from
    // the divisibility table in the abstract — U-CAS-05: a 3M rule on a
    // document carrying no 1M rule scopes to {M3}, because there is nothing
    // to do monthly there. `scheduleRules` is already filtered to `active`
    // rules by the repository's include.
    cascadeFrequencies: resolveCascadeFrequencyScope(
      row.intervalMonths,
      row.assetDocument.scheduleRules.map((sibling) => ({
        frequency: sibling.frequency as unknown as PlannerScheduleRow['frequency'],
        intervalMonths: sibling.intervalMonths,
      })),
    ),

    // Slice 32-PLANNERJOB — the job for the STORED next-due date, and the
    // boundary at which one appears if it has not yet. Both belong to
    // `nextDueOn` alone; every other date in `plannedDates` is a projection of
    // it and nothing has been written against those.
    nextDueJob: job ? toVisitJob(job, assigneeName(job)) : null,
    jobGenerationOpensOn: toIsoDateOnly(jobGenerationOpensOn(row.nextDueOn, leadTimeDays)),

    // WHO NORMALLY DOES THIS PM. Distinct from `nextDueJob.assignedTo` above:
    // this is the plan, that is one occurrence. `eligible: false` is the
    // warning that matters — the next sweep will generate an UNASSIGNED job.
    defaultAssignee:
      row.defaultAssigneeId && defaultAssignee
        ? ({
            id: row.defaultAssigneeId,
            // Withheld, not absent — see the `maySeeNames` note in `list`.
            fullName: maySeeNames ? defaultAssignee.fullName : null,
            eligibility: defaultAssignee.verdict,
          } satisfies PlannerDefaultAssignee)
        : null,
  };
}

function toVisitJob(job: ScheduledVisitJobRow, assigneeName: string | null): PlannerVisitJob {
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    // The same DBD §5 -> wire mapping every other job read uses, never a
    // second hand-written table (`jobs/job-enums.ts`).
    status: JOB_STATUS_FROM_DB[job.status],
    assignedTo: job.assignedTo,
    // `null` exactly when `assignedTo` is: the name comes from the `assignee`
    // relation, which Prisma only populates when the FK is set.
    assignedToName: assigneeName,
  };
}
