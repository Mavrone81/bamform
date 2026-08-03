import { Injectable } from '@nestjs/common';
import {
  resolveTemplateTitle,
  type PlannerScheduleQuery,
  type PlannerScheduleRow,
} from '@bamform/shared';
import { AreaScopeService } from '../common/area-scope';
import { validationFailedProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { resolveCascadeFrequencyScope } from './frequency-cascade';
import { parseIsoDateOnly, projectVisitDates, toIsoDateOnly } from './planner-projection';
import {
  PlannerScheduleRepository,
  type PlannerScheduleRuleRow,
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
  constructor(
    private readonly repo: PlannerScheduleRepository,
    private readonly areaScope: AreaScopeService,
  ) {}

  async list(userId: string, query: PlannerScheduleQuery): Promise<Page<PlannerScheduleRow>> {
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
    return { data: page.data.map((row) => toPlannerRow(row, from, to)), page: page.page };
  }
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

function toPlannerRow(row: PlannerScheduleRuleRow, from: Date, to: Date): PlannerScheduleRow {
  const asset = row.assetDocument.asset;
  const template = row.assetDocument.formTemplate;

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
  };
}
