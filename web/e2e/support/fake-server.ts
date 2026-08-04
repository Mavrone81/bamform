import type { Page, Route } from '@playwright/test';
import {
  generateRecoveryCodes,
  normaliseRecoveryCode,
  randomBase32Secret,
  verifyTotp,
} from './totp';
// Slice 28 review M-2. THE REAL SCHEMAS, not a paraphrase of them.
//
// This fake had hand-written its own idea of what `PATCH /asset-documents/{id}`
// accepts, and got it wrong in the one way that mattered: it normalised `''` to
// `null` while the real `.trim().min(1)` rejects `''` outright. The client
// happily sent `''`, the whole e2e battery went green, and the flow would have
// 422'd in production forever. Validating against the schema the api itself
// compiles makes that particular lie impossible to tell again.
//
// Imported from `shared/src` and not from `@bamform/shared`, deliberately:
// Playwright transpiles the TypeScript source directly, so this does not
// depend on `shared/dist` — which CI's e2e job (`npm ci` → playwright) never
// builds. `zod` is hoisted to the root `node_modules`, so it resolves without
// any change to `web/package.json` or the lockfile.
import { assetDocumentCreateSchema, assetDocumentUpdateSchema } from '../../../shared/src/asset';
// Slice 31-TITLEBLANK, same rationale: THE REAL schema and THE REAL predicate
// for the title's blank, so this fake cannot be kinder (or stricter) than the
// api about what fills it, and cannot hold a second copy of the underscore-run
// rule that could drift from the one the submit gate uses.
import { titleMachineNumberInputSchema } from '../../../shared/src/job';
import { titleHasFillableRun } from '../../../shared/src/template-title';
// Same rationale as above: THE REAL SCHEMA for `PUT /assets/{assetId}/schedule`,
// and the same interval-months table `ScheduleRuleBootstrapService` uses —
// not a second, hand-typed `{M1: 1, ...}` that could quietly drift from it.
import { scheduleAdjustRequestSchema } from '../../../shared/src/schedule';
import { FREQUENCY_INTERVAL_MONTHS, type Frequency } from '../../../shared/src/frequency';
// Slice 31-PLANNER, same rationale again: `GET /schedule` resolves a
// document's title through the REAL `resolveTemplateTitle` the api calls
// (`asset-documents.service.ts`/`planner-schedule.service.ts`), so the fake
// cannot quietly disagree about a fillable run.
import { resolveTemplateTitle } from '../../../shared/src/template-title';

/**
 * A fake backend for the offline suite, installed via Playwright route
 * interception (`page.route`) rather than depending on the real api/
 * workspace. As of this branch `/sync/bootstrap`, `/sync/outbox` and
 * `/jobs/**` are not implemented server-side (slice 6/9/10 work — see
 * src/api/transport.ts's module doc), and the CI compose topology
 * (docker-compose.ci.yml) does not yet stitch bamform-web and bamform-api
 * onto one origin for a same-origin relative fetch to reach the api
 * container. Route interception sidesteps both gaps deterministically: it
 * intercepts every `/api/v1/**` request at the browser network boundary
 * before either question matters, so these tests exercise the REAL client
 * code (outbox.ts, sync-engine.ts, the screens) against a server that
 * behaves exactly as api/openapi.yaml contracts it to, with full control
 * over the fault injection the O-suite requires (dropped responses, 409s,
 * batch caps).
 *
 * This mirrors src/api/mock-transport.ts's semantics (same idempotency
 * store, same "commit before dropping the response" O-15 model) — that one
 * backs the Vitest unit suite; this one backs the browser-driven E2E suite.
 * Two independent tests of the same contract, at two different layers.
 */

export interface SeedJob {
  id: string;
  jobNumber: string;
  assetCode: string;
  /** Slice 13-UI-B: the area the job's asset sits in. Jobs and queue
   * entries are area-scoped for a user who HAS area scopes (PR-API-10) —
   * `undefined` means "no area", which a scoped user never sees, exactly
   * like the real `applyAreaScope` `IN (...)` filter. */
  areaId?: string;
  frequency: 'M1' | 'M3' | 'M6' | 'Y';
  dueOn: string;
  overdue?: boolean;
  status?: string;
  draftVersion?: number;
  revisionId?: string;
  revisionCode?: string;
  /**
   * Slice 31-TITLEBLANK — the frozen revision's TEMPLATE TITLE. Defaults to a
   * title with NO fillable run, so every pre-existing spec sees exactly the
   * screen it always saw (no form-number box, no new submit precondition). A
   * spec that wants the blank seeds a title carrying one, e.g.
   * `'KNS Wire Bond Preventive Maintenance Record KW___'`.
   */
  title?: string;
  /** Slice 31-TITLEBLANK — a value already captured on this record. */
  titleMachineNumber?: string | null;
  items: Array<{ id: string; itemNo: number; instruction: string; mandatory?: boolean }>;
  /** Slice 14-DESIGN (review D-6): pre-recorded results carried on the job
   * payload, so a job seeded directly as `SUBMITTED` can look like one a
   * technician actually filled (a real SUBMITTED record always has results).
   * Optional and defaulting to none — no pre-existing spec seeds these. */
  itemResults?: Array<{
    templateItemId: string;
    status: 'DONE' | 'NOT_DONE' | 'NOT_APPLICABLE';
    remark?: string;
  }>;
  /** Slice 11b additions — only meaningful once a job is (or becomes)
   * `SUBMITTED`; every field defaults to something sensible for jobs that
   * never touch the verifier queue. */
  submittedBy?: string;
  submittedAt?: string;
  currentStageOrdinal?: 1 | 2;
  /** Slice 16 (D-2a): pre-seeded approval history, so a spec can present a
   * job ALREADY returned by a verifier without walking the whole
   * submit→return journey first (e03 covers that journey end-to-end). */
  approvalSteps?: Array<{
    stageOrdinal: number;
    stageLabel: string;
    action: 'SUBMITTED' | 'VERIFIED' | 'RETURNED' | 'RECALLED' | 'VOIDED';
    actorId: string;
    actorName: string;
    reason?: string | null;
    actedAt: string;
  }>;
}

interface OutboxResultLike {
  id: string;
  status: number;
  applied: boolean;
  problem?: unknown;
}

/**
 * Slice 11b: a small fixed cast of users so the verifier-queue/delegation
 * journeys (E-02/03/04) can exercise multiple distinct actors — the
 * SUBMITTER, a TEAM_LEADER, an ENGINEER and a delegate — within one
 * FakeServer instance, each in their own BrowserContext (mirrors how
 * O-13/O-14 already use separate contexts sharing one server). Every
 * existing offline/a11y spec signs in as `tech@bevorasg.com` and is
 * completely unaffected: unknown emails fall back to the same
 * user-1/MAINTAINER identity they always got.
 */
export interface E2EUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
}

export const E2E_USERS: {
  technician: E2EUser;
  teamLeader: E2EUser;
  engineer: E2EUser;
  delegate: E2EUser;
  admin: E2EUser;
} = {
  technician: {
    id: 'user-1',
    email: 'tech@bevorasg.com',
    fullName: 'Test Technician',
    roles: ['MAINTAINER'],
  },
  teamLeader: {
    id: 'user-2',
    email: 'leader@bevorasg.com',
    fullName: 'Test Team Leader',
    roles: ['TEAM_LEADER'],
  },
  engineer: {
    id: 'user-3',
    email: 'engineer@bevorasg.com',
    fullName: 'Test Engineer',
    roles: ['ENGINEER'],
  },
  // Deliberately NOT a TEAM_LEADER/ENGINEER of their own — the only way
  // this user can appear in a stage's queue is via an active delegation
  // (E-04), so the journey genuinely proves the delegation path rather
  // than a role this user would have had access through anyway.
  delegate: {
    id: 'user-4',
    email: 'delegate@bevorasg.com',
    fullName: 'Test Delegate',
    roles: ['MAINTAINER'],
  },
  // Slice 13-UI-A. ADMIN is in the default MFA_REQUIRED_ROLES list, which is
  // exactly why the MFA journeys use it — and it is the role production's
  // only account holds, so these tests exercise the case that made the flags
  // unsafe to enable in the first place.
  admin: {
    id: 'user-5',
    email: 'admin@bevorasg.com',
    fullName: 'Test Administrator',
    roles: ['ADMIN'],
  },
};

/**
 * The password every canned user starts with. It IS checked, on `/auth/login`
 * (slice 13-UI-A: the password-change journey needs the old password to stop
 * working and the new one to start), on `/auth/step-up`, and on
 * `/auth/password` as the `currentPassword`. Comfortably over the 12-character
 * minimum `shared/src/mfa.ts` enforces.
 */
export const E2E_PASSWORD = 'correct-horse-battery-staple';

/** Default `MFA_REQUIRED_ROLES` (slice 13-MFA D-1). `MAINTAINER` is exempt —
 * SEC RS-3/SO-3 — which is why the technician journeys are untouched by MFA
 * even when it is switched on. */
export const MFA_REQUIRED_ROLES = ['ADMIN', 'TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'AUDITOR'];

/** Endpoints a `must_change_password` user may still reach (slice 13-MFA §7). */
const PASSWORD_CHANGE_ALLOWED_PATHS = ['/auth/me', '/auth/password', '/auth/logout'];

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Slice 13-UI-B — the fake's mutable user record behind `/users`. */
export interface FakeAdminUser extends E2EUser {
  active: boolean;
  employeeId: string | null;
  areaIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FakeArea {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  active: boolean;
}

export interface FakeAssetType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  formTemplateId: string;
  approvalRouteId: string;
  leadTimeDays: number;
  active: boolean;
}

export interface FakeAsset {
  id: string;
  code: string;
  codeProvisional: boolean;
  assetTypeId: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  areaId: string | null;
  locationDetail: string | null;
  commissionedOn: string | null;
  scheduleAnchorDate: string;
  status: 'ACTIVE' | 'UNDER_REPAIR' | 'DECOMMISSIONED';
  active: boolean;
}

/**
 * Slice 27/28-ASSETDOC — a controlled document in the catalogue (`/templates`,
 * loaded by BAMFORM-TLP-001's tooling in production, canned reference data
 * here). Three of the twelve real shapes are represented: a title with a
 * fillable run, a title with the number already printed (EP01), and one with a
 * run but no approved revision.
 */
export interface FakeTemplate {
  id: string;
  documentNumber: string;
  title: string;
  active: boolean;
  currentRevisionId: string | null;
  /**
   * Slice 27/29 — stands in for "the distinct active `frequency`s on this
   * template's CURRENT revision" (`ScheduleRuleBootstrapService.ensureForOne`
   * reads exactly that). A template with no current revision (`agingOven`)
   * carries none, matching the real bootstrap's no-op for that case.
   */
  frequencies: Frequency[];
}

/**
 * Review M-2: real UUIDs, because `assetDocumentCreateSchema.formTemplateId`
 * is `z.string().uuid()` and the fake now parses with that schema. The old
 * readable `tpl-wb` ids would have been refused by the real server too — a
 * second, smaller instance of the fake being kinder than production.
 */
export const E2E_TEMPLATES = {
  /** `KNS Wire Bond … KW___` — a title with a fillable run. */
  wireBond: '11111111-1111-4111-8111-111111111111',
  /** `Epoxy Dispenser EP01 …` — the number is printed already. */
  epoxy: '22222222-2222-4222-8222-222222222222',
  /** A fillable title with NO approved revision. */
  agingOven: '33333333-3333-4333-8333-333333333333',
} as const;

/** A document tagged to a machine (`asset_document`). */
export interface FakeAssetDocument {
  id: string;
  assetId: string;
  formTemplateId: string;
  machineNumber: string | null;
  active: boolean;
}

/**
 * Slice 29-SCHEDULE-UI — `schedule_rule`, hung off the document exactly as
 * `AssetScheduleService`/`ScheduleRuleBootstrapService` model it (one row per
 * `(assetDocumentId, frequency)`), not off the machine. `assetId` is NOT
 * stored here, deliberately mirroring `toDto` in `asset-schedule.service.ts`,
 * which derives it from `row.assetDocument.assetId` — this fake does the same
 * lookup at read time via `assetDocumentsById`.
 */
export interface FakeScheduleRule {
  id: string;
  assetDocumentId: string;
  frequency: Frequency;
  intervalMonths: number;
  anchorDate: string;
  lastCompletedOn: string | null;
  nextDueOn: string;
  adjustedReason: string | null;
  active: boolean;
}

/** The six seeded roles (`role` reference data, seeded by migration). */
export const FAKE_ROLES: Array<{ id: string; code: string; name: string; description: null }> = [
  { id: 'role-1', code: 'MAINTAINER', name: 'Maintainer', description: null },
  { id: 'role-2', code: 'TEAM_LEADER', name: 'Team Leader', description: null },
  { id: 'role-3', code: 'ENGINEER', name: 'Engineer', description: null },
  { id: 'role-4', code: 'DOC_CONTROLLER', name: 'Document Controller', description: null },
  { id: 'role-5', code: 'ADMIN', name: 'Administrator', description: null },
  { id: 'role-6', code: 'AUDITOR', name: 'Auditor', description: null },
];

export interface FakeDelegation {
  id: string;
  delegatorId: string;
  delegateId: string;
  validFrom: string;
  validTo: string;
  reason: string | null;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
}

interface ApprovalStepLike {
  id: string;
  stageOrdinal: number;
  stageLabel: string;
  action: 'SUBMITTED' | 'VERIFIED' | 'RETURNED' | 'RECALLED' | 'VOIDED';
  actorId: string;
  actorName: string;
  actorRoleCode?: string;
  onBehalfOfName?: string | null;
  reason?: string | null;
  actedAt: string;
}

/**
 * Slice 31-PLANNER. The date arithmetic behind `GET /schedule`'s
 * `plannedDates`, mirroring `api/src/scheduling/planner-projection.ts`:
 * occurrences are `nextDueOn + n·intervalMonths` computed from the ORIGINAL
 * anchor (never by stepping off the previous, clamped result, which would
 * lose a month-end anchor for good) and clamped to the last day of a short
 * month, exactly as `addCalendarMonthsClamped` does.
 *
 * Written here in `YYYY-MM-DD` strings rather than importing the api's copy:
 * `web/e2e` deliberately does not depend on the `api` workspace at all (see
 * this file's own header), and a wrong projection would surface as a visit
 * drawn in the wrong column, which the journey spec asserts against.
 */
/**
 * A deterministic, well-formed UUIDv4-shaped id from a counter.
 *
 * Slice 31-PLANNER found this the hard way. `asset_document` ids were
 * `ad-1`, `ad-2`, … which read nicely — but `scheduleAdjustRequestSchema`
 * (the REAL schema this fake parses with, review M-2) types
 * `assetDocumentId` as `z.string().uuid()`, and both schedule editors ALWAYS
 * send it. So every adjust through the fake was refused with the contentless
 * "Request body failed validation.", a refusal the real server could never
 * give, because its ids are `uuidv7()`. No spec had exercised a save through
 * the fake before, so nothing caught it: the fake was STRICTER than
 * production in exactly the place that made a working flow look broken —
 * the mirror image of the `''`-vs-`null` lie that made review M-2 import
 * these schemas in the first place.
 *
 * Same reasoning as `E2E_TEMPLATES`' real UUIDs, applied to every generated
 * id that crosses a request body.
 */
function fakeUuid(prefix: number, counter: number): string {
  const tail = String(counter).padStart(12, '0');
  return `${String(prefix).repeat(8)}-0000-4000-8000-${tail}`;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addCalendarMonthsClamped(iso: string, months: number): string {
  const from = new Date(`${iso}T00:00:00.000Z`);
  const targetMonth = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(from.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(from.getUTCFullYear(), targetMonth, Math.min(from.getUTCDate(), lastDay)),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Slice 32-PLANNERJOB — the tuple that names one planned visit's job, mirroring
 * `planner-schedule.repository.ts#findScheduledJobsForVisits`: the DOCUMENT
 * (not the machine — one machine can carry several), the FREQUENCY (one
 * document can carry several rules), and the STORED due date.
 */
/**
 * Slice 32-PLANNERJOB — the roles that can record results, mirroring
 * `api/src/jobs/job-access.ts#JOB_RECORD_ROLES`. An assignee must hold one, or
 * the assignment is a dead end: result capture is `@Roles(JOB_RECORD_ROLES)`.
 */
const JOB_RECORD_ROLES: readonly string[] = ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'];

/** The four roles that may assign — `@Roles()` on both assignment routes. */
const ASSIGN_ROLES: string[] = ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'];

function visitJobKey(assetDocumentId: string, frequency: string, dueOn: string): string {
  return `${assetDocumentId}|${frequency}|${dueOn}`;
}

/** Whole UTC calendar days, matching the api's own `addDays` on DATE columns. */
function addDaysIso(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function projectVisitDates(
  nextDueOn: string,
  intervalMonths: number,
  from: string,
  to: string,
): string[] {
  if (!isIsoDate(nextDueOn) || intervalMonths < 1) {
    return nextDueOn >= from && nextDueOn <= to ? [nextDueOn] : [];
  }
  const dates: string[] = [];
  // 256 matches MAX_PROJECTED_VISITS_PER_RULE — a bound, not a business rule.
  for (let step = 0; step < 256; step += 1) {
    const occurrence =
      step === 0 ? nextDueOn : addCalendarMonthsClamped(nextDueOn, step * intervalMonths);
    if (occurrence > to) break;
    if (occurrence >= from) dates.push(occurrence);
  }
  return dates;
}

export class FakeServer {
  // ---- Slice 13-UI-B: mutable admin state (users/areas/asset-types/assets).
  //
  // The canned E2E_USERS become MUTABLE rows here (the static export stays
  // for identity/credential constants in specs): `/users` administration
  // edits these, and users created through the UI live alongside them —
  // able to sign in, refresh, and be scoped exactly like the canned cast.
  private adminUsers = new Map<string, FakeAdminUser>(
    Object.values(E2E_USERS).map((u) => [
      u.id,
      {
        ...u,
        roles: [...u.roles],
        active: true,
        employeeId: null,
        areaIds: [],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ]),
  );
  /** Ids continue the `user-N` shape so every existing bearer regex
   * (`e2e-token-user-\d+`) keeps matching created users too. */
  private userSeq = 100;
  private areasById = new Map<string, FakeArea>();
  private areaSeq = 0;
  private assetTypesById = new Map<string, FakeAssetType>();
  private assetsById = new Map<string, FakeAsset>();
  private assetSeq = 0;
  private provisionalSeq = 0;
  /** Slice 28-ASSETDOC-UI — the `/templates` catalogue and the tagged
   * documents. Deliberately mirrors three of the twelve real title shapes so
   * `titleHasFillableRun` has both branches to exercise. */
  private templatesById = new Map<string, FakeTemplate>();
  private assetDocumentsById = new Map<string, FakeAssetDocument>();
  private assetDocumentSeq = 0;
  /** Slice 29-SCHEDULE-UI — hung off `assetDocumentsById`, not a parallel
   * per-machine store, so tagging/retiring a document stays consistent with
   * what `GET /assets/{assetId}/schedule` returns (see `bootstrapScheduleRules`
   * and `scheduleRulesOf`). */
  private scheduleRulesById = new Map<string, FakeScheduleRule>();
  private scheduleRuleSeq = 0;
  /**
   * Slice 32-PLANNERJOB — the jobs the SCHEDULER has raised against planned
   * visits, keyed the way the real system keys them:
   * `(assetDocumentId, frequency, dueOn)`. See `seedGeneratedJob`.
   *
   * Kept apart from `jobs` (the `SeedJob` store the job screens read) because
   * they answer different questions: `jobs` is "what does `GET /jobs/{id}`
   * return", this is "is there a job for this VISIT". `seedGeneratedJob`
   * writes both, so a spec can follow the planner's link into a real capture
   * screen rather than a 404.
   */
  private generatedJobsByVisit = new Map<
    string,
    { id: string; jobNumber: string; status: string }
  >();
  private generatedJobSeq = 0;
  /**
   * Slice 32-PLANNERJOB — `schedule_rule.default_assignee_id`, keyed by rule.
   * WHO NORMALLY DOES THIS PM. Kept apart from `jobAssignees` below because
   * the two levels are independent in the real system and a fake that stored
   * them together could never fail the test that proves it.
   */
  private ruleDefaultAssignee = new Map<string, string | null>();
  /** `job.assigned_to`, keyed by job — WHO IS DOING THIS ONE. */
  private jobAssignees = new Map<string, string | null>();

  constructor() {
    // A small canned asset-type catalogue (reference data the real system
    // seeds by migration/template-load) so the machines screens have types
    // to hang machines off without every spec seeding them.
    this.seedAssetType({ code: 'WB', name: 'Wire Bonder' });
    this.seedAssetType({ code: 'AO', name: 'Aging Oven' });
    for (const template of [
      {
        id: E2E_TEMPLATES.wireBond,
        documentNumber: 'CE 95 020 00 03',
        title: 'KNS Wire Bond Preventive Maintenance Record KW___',
        active: true,
        currentRevisionId: 'rev-wb',
        // One monthly item on the current revision.
        frequencies: ['M1'] as Frequency[],
      },
      {
        id: E2E_TEMPLATES.epoxy,
        documentNumber: 'CE 95 020 00 01',
        title: 'Epoxy Dispenser EP01 Preventive Maintenance Record',
        active: true,
        currentRevisionId: 'rev-ep',
        // A quarterly item on the current revision.
        frequencies: ['M3'] as Frequency[],
      },
      {
        id: E2E_TEMPLATES.agingOven,
        documentNumber: 'CE 95 050 00 01',
        title: 'Aging Oven Preventive Maintenance Record ______',
        active: true,
        currentRevisionId: null,
        // No CURRENT revision — `ensureForOne` no-ops for exactly this case,
        // so this template schedules nothing, ever (mirrored, not invented).
        frequencies: [] as Frequency[],
      },
    ]) {
      this.templatesById.set(template.id, template);
    }
  }

  userById(id: string): FakeAdminUser | undefined {
    return this.adminUsers.get(id);
  }

  private userByEmail(email: string): FakeAdminUser | undefined {
    return Array.from(this.adminUsers.values()).find((u) => u.email === email);
  }

  seedArea(input: { code: string; name: string; active?: boolean }): FakeArea {
    const area: FakeArea = {
      id: `area-${++this.areaSeq}`,
      code: input.code,
      name: input.name,
      parentId: null,
      active: input.active ?? true,
    };
    this.areasById.set(area.id, area);
    return area;
  }

  seedAssetType(input: { code: string; name: string; leadTimeDays?: number }): FakeAssetType {
    const id = `at-${this.assetTypesById.size + 1}`;
    const assetType: FakeAssetType = {
      id,
      code: input.code,
      name: input.name,
      description: null,
      formTemplateId: `tpl-${id}`,
      approvalRouteId: 'route-1',
      // Slice 32-PLANNERJOB made this settable. It decides
      // `jobGenerationOpensOn` — how far before its due date the scheduler
      // raises a machine family's work — and a spec can only prove the planner
      // prints the SERVER's boundary rather than a hard-coded 30 by seeding a
      // family whose lead time is not 30.
      leadTimeDays: input.leadTimeDays ?? 30,
      active: true,
    };
    this.assetTypesById.set(id, assetType);
    return assetType;
  }

  /** Slice 18-WORKFLOW — a machine the "Raise a job" screen can offer,
   * without going through the admin create flow first. */
  /**
   * `scheduleAnchorDate` is settable (slice 31-PLANNER): a document tagged to
   * this machine bootstraps its rules with `nextDueOn` equal to the anchor,
   * so it is the only way a spec can put a visit in a KNOWN work week rather
   * than in whichever week the suite happens to run in. Defaults to today,
   * unchanged for every existing caller.
   */
  seedAsset(input: {
    code: string;
    assetTypeId: string;
    description?: string;
    scheduleAnchorDate?: string;
  }): FakeAsset {
    const asset: FakeAsset = {
      id: `asset-${++this.assetSeq}`,
      code: input.code,
      codeProvisional: false,
      assetTypeId: input.assetTypeId,
      description: input.description ?? null,
      manufacturer: null,
      model: null,
      serialNumber: null,
      areaId: null,
      locationDetail: null,
      commissionedOn: null,
      scheduleAnchorDate: input.scheduleAnchorDate ?? new Date().toISOString().slice(0, 10),
      status: 'ACTIVE',
      active: true,
    };
    this.assetsById.set(asset.id, asset);
    return asset;
  }

  /** Tags a document to a machine directly, so a spec can start from a
   * machine that already carries one (the e12 journey tags through the UI). */
  seedAssetDocument(input: {
    assetId: string;
    formTemplateId: string;
    machineNumber?: string | null;
    active?: boolean;
  }): FakeAssetDocument {
    const doc: FakeAssetDocument = {
      // A real UUID — the schemas this fake parses with demand one (`fakeUuid`).
      id: fakeUuid(4, ++this.assetDocumentSeq),
      assetId: input.assetId,
      formTemplateId: input.formTemplateId,
      machineNumber: input.machineNumber ?? null,
      active: input.active ?? true,
    };
    this.assetDocumentsById.set(doc.id, doc);
    this.bootstrapScheduleRules(doc);
    return doc;
  }

  /**
   * Mirrors `ScheduleRuleBootstrapService.ensureForOne`: one `schedule_rule`
   * per distinct frequency the document's template carries, anchored on the
   * MACHINE's `scheduleAnchorDate` (several documents on one machine share
   * one anchor), `nextDueOn` starting equal to it. `skipDuplicates`-style
   * idempotency (`(assetDocumentId, frequency)`) so calling this twice for
   * the same document never doubles its rows.
   */
  private bootstrapScheduleRules(doc: FakeAssetDocument): void {
    const template = this.templatesById.get(doc.formTemplateId);
    if (!template || template.frequencies.length === 0) return;
    const asset = this.assetsById.get(doc.assetId);
    const anchor = asset?.scheduleAnchorDate ?? new Date().toISOString().slice(0, 10);
    const existing = new Set(
      Array.from(this.scheduleRulesById.values())
        .filter((r) => r.assetDocumentId === doc.id)
        .map((r) => r.frequency),
    );
    for (const frequency of template.frequencies) {
      if (existing.has(frequency)) continue;
      const rule: FakeScheduleRule = {
        id: fakeUuid(5, ++this.scheduleRuleSeq),
        assetDocumentId: doc.id,
        frequency,
        intervalMonths: FREQUENCY_INTERVAL_MONTHS[frequency],
        anchorDate: anchor,
        lastCompletedOn: null,
        nextDueOn: anchor,
        adjustedReason: null,
        active: true,
      };
      this.scheduleRulesById.set(rule.id, rule);
    }
  }

  /**
   * Slice 32-PLANNERJOB — stands in for a scheduler sweep having already
   * raised the job for one planned visit.
   *
   * KEYED THE WAY THE REAL SYSTEM KEYS IT. `job` carries a partial unique
   * index on `(asset_document_id, frequency_scope, due_on) WHERE status <>
   * 'voided' AND is_adhoc = false`, and `planner-schedule.repository.ts`
   * matches the equivalent `(assetDocumentId, frequency, dueOn)`. Modelling
   * anything looser here — "the job for this machine", say — would let a
   * broken match in the app pass CI, which is the whole reason this file
   * mirrors the real service rather than simplifying it.
   *
   * It also seeds a real `SeedJob` under the same id, so following the
   * planner's link lands on a capture screen instead of a 404 — the journey
   * this slice exists for is only proved end to end if the destination
   * actually opens.
   */
  seedGeneratedJob(input: {
    assetDocumentId: string;
    frequency: Frequency;
    dueOn: string;
    assetCode: string;
    status?: string;
    title?: string;
  }): { id: string; jobNumber: string } {
    const n = ++this.generatedJobSeq;
    const id = `gen-job-${n}`;
    const jobNumber = `PM-2026-${String(1000 + n).padStart(6, '0')}`;
    this.generatedJobsByVisit.set(
      visitJobKey(input.assetDocumentId, input.frequency, input.dueOn),
      { id, jobNumber, status: input.status ?? 'SCHEDULED' },
    );
    this.seedJob({
      id,
      jobNumber,
      assetCode: input.assetCode,
      frequency: input.frequency,
      dueOn: input.dueOn,
      status: input.status ?? 'SCHEDULED',
      title: input.title,
      items: [{ id: `${id}-item-1`, itemNo: 1, instruction: 'Planned check', mandatory: true }],
    });
    return { id, jobNumber };
  }

  /**
   * The rule a document's template bootstrapped at `frequency` — slice
   * 32-PLANNERJOB. A spec needs the rule ID to set a standing assignee, and
   * rules are created implicitly by `seedAssetDocument`, never by the spec.
   */
  scheduleRuleFor(assetDocumentId: string, frequency: Frequency): FakeScheduleRule {
    const rule = Array.from(this.scheduleRulesById.values()).find(
      (candidate) =>
        candidate.assetDocumentId === assetDocumentId && candidate.frequency === frequency,
    );
    if (!rule) {
      throw new Error(`no ${frequency} schedule rule on document ${assetDocumentId}`);
    }
    return rule;
  }

  /**
   * Sets `schedule_rule.default_assignee_id` DIRECTLY, bypassing the endpoint
   * — for a spec that needs the standing assignee as a starting CONDITION
   * rather than as the thing under test. The journey that actually sets one
   * does it through the UI.
   */
  setRuleDefaultAssignee(scheduleRuleId: string, userId: string | null): void {
    this.ruleDefaultAssignee.set(scheduleRuleId, userId);
  }

  /**
   * Deactivates a user, the way slice 13a's administration does (INV-16: no
   * hard delete, ever). This is how a standing assignee LAPSES — the exact
   * condition that makes the next sweep generate an unassigned job.
   */
  deactivateUser(userId: string): void {
    const user = this.adminUsers.get(userId);
    if (user) user.active = false;
  }

  /** Scopes a user directly (bypassing the PUT endpoint) so a spec can set
   * up a starting condition; the E-06 journey assigns scope through the UI. */
  seedUserAreaScope(userId: string, areaIds: string[]): void {
    const user = this.adminUsers.get(userId);
    if (!user) throw new Error(`seedUserAreaScope: unknown user ${userId}`);
    user.areaIds = [...areaIds];
  }

  private jobs = new Map<string, SeedJob>();
  private deletedJobIds = new Set<string>();
  private idempotencyStore = new Map<string, OutboxResultLike>();
  appliedCount = new Map<string, number>();
  private conflictOnce = new Set<string>();
  private dropResponseOnce = new Set<string>();
  networkDown = false;
  serverTime = new Date().toISOString();
  outboxRequestCount = 0;
  submitCount = new Map<string, number>();
  private submitStore = new Map<string, unknown>();
  /** Every mutation batch ever received, in arrival order — lets a test
   * assert exactly what was sent without needing to peek into IndexedDB. */
  receivedBatches: Array<{ id: string; path: string }[]> = [];
  /** Real optimistic-concurrency tracking (mirrors the `draftVersion` /
   * `If-Match` contract, api/openapi.yaml `IfMatch` parameter): a mutation
   * whose `ifMatch` does not match the job's current version is rejected
   * 409, exactly as PR-064 describes — this is what makes O-13 (two
   * devices editing the same job) a genuine test of the mechanism rather
   * than a canned one-shot conflict. */
  private draftVersions = new Map<string, number>();

  /** Slice 11b: mutable per-job approval state. Kept SEPARATE from the
   * immutable `SeedJob` a test seeds with, defaulting to that job's own
   * `status`/`currentStageOrdinal` fields until `/submit`, `/verify` or
   * `/return` actually changes them — so every pre-existing offline/a11y
   * spec (none of which touch the verifier queue) is completely unaffected. */
  private jobStatus = new Map<string, string>();
  private jobStageOrdinal = new Map<string, 1 | 2>();
  private jobSubmittedBy = new Map<string, string>();
  private jobSubmittedAt = new Map<string, string>();
  private approvalSteps = new Map<string, ApprovalStepLike[]>();
  private approvalStepSeq = 0;
  private delegations = new Map<string, FakeDelegation>();
  private delegationSeq = 0;
  /** Users who have completed `/auth/step-up` and not yet had it consumed
   * by a `/verify` call — real re-authentication IS required per user, per
   * signing action (there is no "logging in satisfies it" shortcut here),
   * which is what makes the pad's step-up-retry path a genuine test rather
   * than one that trivially never fires. */
  private stepUpValidUserIds = new Set<string>();

  // ---- Slice 13-UI-A: MFA + password self-service state ----
  //
  // `mfaEnabled` defaults to FALSE, deliberately mirroring the api's
  // `MFA_ENABLED` default and production's current setting. Every pre-slice-13
  // spec therefore sees the one-step login it always saw; the MFA journeys opt
  // in explicitly with `enableMfa()`.
  private mfaEnabled = false;
  private passwords = new Map<string, string>();
  private mustChangePassword = new Set<string>();
  private enrolledUserIds = new Set<string>();
  private confirmedSecrets = new Map<string, string>();
  private pendingSecrets = new Map<string, string>();
  private lastUsedStep = new Map<string, number>();
  /** userId -> normalised code -> used. Codes are marked used, never removed
   * (INV-07), so a reuse is genuinely detected rather than silently missed. */
  private recoveryCodes = new Map<string, Map<string, boolean>>();
  private challenges = new Map<string, { userId: string; expiresAt: number }>();
  private consumedChallenges = new Set<string>();
  private challengeSeq = 0;
  /** Every TOTP code the fake ever rejected, so a spec can assert the
   * rejection really happened at the server rather than in the UI. */
  rejectedTotpCodes: string[] = [];

  /** Turns on enforcement, as flipping `MFA_ENABLED=true` would. */
  enableMfa(): void {
    this.mfaEnabled = true;
  }

  /** Pre-enrols a user with a known secret, so a spec can act as their phone.
   * Returns the base32 secret. */
  seedMfaEnrolment(userId: string, secret: string = randomBase32Secret()): string {
    this.enrolledUserIds.add(userId);
    this.confirmedSecrets.set(userId, secret);
    return secret;
  }

  /** Issues recovery codes to an already-enrolled user (the enrolment journey
   * gets its codes from `/auth/mfa/enrol/confirm` like a real user does). */
  seedRecoveryCodes(userId: string, count = 10): string[] {
    const codes = generateRecoveryCodes(count);
    this.recoveryCodes.set(userId, new Map(codes.map((c) => [normaliseRecoveryCode(c), false])));
    return codes;
  }

  /** Marks a user as admin-created, i.e. `must_change_password = true`. */
  seedMustChangePassword(userId: string): void {
    this.mustChangePassword.add(userId);
  }

  isEnrolled(userId: string): boolean {
    return this.enrolledUserIds.has(userId);
  }

  passwordOf(userId: string): string {
    return this.passwords.get(userId) ?? E2E_PASSWORD;
  }

  seedJob(job: SeedJob): void {
    this.jobs.set(job.id, job);
    this.draftVersions.set(job.id, job.draftVersion ?? 1);
    this.jobStatus.set(job.id, job.status ?? 'IN_PROGRESS');
    this.jobStageOrdinal.set(job.id, job.currentStageOrdinal ?? 1);
    if (job.submittedBy) this.jobSubmittedBy.set(job.id, job.submittedBy);
    if (job.submittedAt) this.jobSubmittedAt.set(job.id, job.submittedAt);
    if (!this.approvalSteps.has(job.id)) this.approvalSteps.set(job.id, []);
    if (job.approvalSteps?.length) {
      this.approvalSteps.set(
        job.id,
        job.approvalSteps.map((step) => ({ id: `step-${++this.approvalStepSeq}`, ...step })),
      );
    }
  }

  /** Grants a delegation directly (bypassing `POST /delegations`) so a test
   * can set up E-04's starting condition without needing UI interaction
   * first. `createDelegation` (via the real endpoint) is exercised
   * separately by whichever journey actually creates one through the UI. */
  seedDelegation(input: {
    delegatorId: string;
    delegateId: string;
    validFrom: string;
    validTo: string;
    reason?: string | null;
  }): FakeDelegation {
    const id = `deleg-${++this.delegationSeq}`;
    const delegation: FakeDelegation = {
      id,
      delegatorId: input.delegatorId,
      delegateId: input.delegateId,
      validFrom: input.validFrom,
      validTo: input.validTo,
      reason: input.reason ?? null,
      createdBy: input.delegatorId,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.delegations.set(id, delegation);
    return delegation;
  }

  removeJob(jobId: string): void {
    this.jobs.delete(jobId);
    this.deletedJobIds.add(jobId);
  }

  draftVersionOf(jobId: string): number {
    return this.draftVersions.get(jobId) ?? 1;
  }

  forceConflictOnce(mutationId: string): void {
    this.conflictOnce.add(mutationId);
  }

  /** Coarser sibling of `forceConflictOnce`, for the same reason
   * `dropNextOutboxResponseOnce` exists: a client-generated UUIDv7 can't be
   * known ahead of the tap that creates it. Conflicts every mutation in the
   * very next `/sync/outbox` batch, regardless of id. */
  private forceNextConflict = false;
  forceNextConflictOnce(): void {
    this.forceNextConflict = true;
  }

  dropResponseOnceFor(mutationId: string): void {
    this.dropResponseOnce.add(mutationId);
  }

  /** Coarser than `dropResponseOnceFor`: drops the response for the very
   * next `/sync/outbox` request regardless of which mutation ids it
   * carries, after committing them normally — used where a test cannot
   * predict a client-generated UUIDv7 ahead of time (which is always, since
   * it is generated in the browser at the moment of the tap). This models
   * O-02/O-15 precisely: the server applied the batch, the client never saw
   * the response. */
  private dropNextResponse = false;
  dropNextOutboxResponseOnce(): void {
    this.dropNextResponse = true;
  }

  private jobIdFromPath(path: string): string | null {
    const match = path.match(/\/jobs\/([^/]+)\//);
    return match ? match[1] : null;
  }

  /** Slice 31-TITLEBLANK — `job.title_machine_number`, mutated by the outbox
   * route exactly as the real `TitleMachineNumberService` mutates the column.
   * Kept SEPARATE from the immutable `SeedJob` for the same reason
   * `jobStatus` is. */
  private jobTitleMachineNumber = new Map<string, string | null>();

  private titleOf(job: SeedJob): string {
    return job.title ?? 'Preventive Maintenance Record';
  }

  private titleMachineNumberOf(job: SeedJob): string | null {
    return this.jobTitleMachineNumber.get(job.id) ?? job.titleMachineNumber ?? null;
  }

  private toApiJob(job: SeedJob) {
    const title = this.titleOf(job);
    return {
      id: job.id,
      jobNumber: job.jobNumber,
      assetId: job.id,
      assetCode: job.assetCode,
      documentNumber: 'CE 95 020 00 01',
      revisionCode: job.revisionCode ?? 'A',
      frequency: job.frequency,
      frequencyScope: [job.frequency],
      dueOn: job.dueOn,
      overdue: job.overdue ?? false,
      status: this.jobStatus.get(job.id) ?? job.status ?? 'IN_PROGRESS',
      assignedTo: 'user-1',
      assignedToName: 'Test Technician',
      draftVersion: this.draftVersionOf(job.id),
      // Slice 31-TITLEBLANK. `titleHasFillableRun` is DERIVED from the title
      // by the same shared predicate the api uses — never hand-set — so a
      // fake job can never claim a blank its title does not have.
      titleMachineNumber: this.titleMachineNumberOf(job),
      titleHasFillableRun: titleHasFillableRun(title),
      templateRevision: {
        id: job.revisionId ?? `rev-${job.id}`,
        formTemplateId: 'tpl-1',
        documentNumber: 'CE 95 020 00 01',
        title,
        revisionCode: job.revisionCode ?? 'A',
        sequenceOrdinal: 1,
        status: 'CURRENT',
        items: job.items.map((i, idx) => ({
          id: i.id,
          itemNo: i.itemNo,
          frequency: job.frequency,
          instruction: i.instruction,
          mandatory: i.mandatory ?? true,
          stableKey: `item-${idx}`,
          displayOrder: idx,
        })),
        measurements: [],
      },
      itemResults: (job.itemResults ?? []).map((r, idx) => ({
        id: `seed-result-${job.id}-${idx}`,
        templateItemId: r.templateItemId,
        status: r.status,
        remark: r.remark ?? null,
        recordedByName: 'Test Technician',
        recordedAt: job.submittedAt ?? new Date().toISOString(),
      })),
      measurementResults: [],
      partsUsed: [],
      attachments: this.attachments.get(job.id) ?? [],
      approvalSteps: this.approvalSteps.get(job.id) ?? [],
    };
  }

  private currentStageRole(ordinal: number): 'TEAM_LEADER' | 'ENGINEER' {
    return ordinal >= 2 ? 'ENGINEER' : 'TEAM_LEADER';
  }

  /**
   * The DELIVERED route's stage labels, verbatim from the seed/migration
   * chain (`approval_stage.label` on `TWO_STAGE_TL_THEN_ENG`). Hard-coded
   * here on purpose: if production's labels change, this fake stops matching
   * and the mismatch surfaces rather than the fake quietly inventing text
   * the real API never sends.
   */
  private currentStageLabel(ordinal: number): string {
    return ordinal >= 2
      ? 'Verified By (Supervisor / Engineer)'
      : 'Verified By (Workshop Team Leader)';
  }

  /**
   * `POST /auth/logout`. Two things the real endpoint does that this fake must
   * also do, each because omitting it let a real defect through:
   *
   *  1. It REQUIRES the bearer token — the route is not `@Public()` and is
   *     covered by openapi.yaml's global `security: [bearerAuth]`. Fulfilling
   *     unconditionally let the web client ship a header-less `logout()` that
   *     returns 401 in production while every E2E test passed (fix-delta
   *     re-review, finding C-1). Verified against live prod: no header → 401
   *     and the refresh cookie still mints a session; with header → 204 and
   *     refresh then → 401.
   *  2. It expires `bf_refresh`, so a reload after signing out lands on the
   *     sign-in screen rather than resurrecting the session — which is the one
   *     thing E-07e exists to prove (review finding I-3).
   */
  private async handleLogout(route: Route): Promise<void> {
    // Same UNANCHORED shape the sibling handlers use (`currentUser`, :429) —
    // deliberately not `$`-anchored, because `handleRefresh` issues
    // `e2e-token-<id>-refreshed` (:787) and a strict tail match would reject a
    // perfectly valid rotated token. An anchored version of this check made
    // E-07e fail exactly as the real bug does: 401 → cookie kept → the session
    // survives the reload. What must be rejected is an absent or unparseable
    // bearer, which is the C-1 regression.
    const auth = (await route.request().headerValue('authorization')) ?? '';
    if (!/Bearer e2e-token-user-\d+/.test(auth)) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(401, 'Unauthenticated')),
      });
      return;
    }
    await route.fulfill({
      status: 204,
      headers: { 'Set-Cookie': 'bf_refresh=; Path=/; HttpOnly; Max-Age=0' },
      body: '',
    });
  }

  private async currentUser(route: Route): Promise<FakeAdminUser> {
    const auth = (await route.request().headerValue('authorization')) ?? '';
    const match = auth.match(/Bearer e2e-token-(user-\d+)/);
    const userId = match?.[1];
    return (userId && this.adminUsers.get(userId)) || this.adminUsers.get('user-1')!;
  }

  private problem(status: number, title: string, type = 'about:blank') {
    return { type, title, status };
  }

  /** Real login is required before refresh will succeed for THAT SAME
   * browser context — modelled with an actual `Set-Cookie` on login and a
   * `Cookie` check on refresh, exactly like the real HttpOnly refresh
   * cookie, rather than a single shared boolean. A single global flag was
   * tried first and broke as soon as a second "device" (BrowserContext)
   * appeared in the same test (O-13): logging in on device A made device
   * B's fresh page silently auto-authenticate via refresh too, since
   * cookies are NOT actually shared between real browser contexts — the
   * flag was pretending they were. Without this fix, every fresh page load
   * for a context that never logged in would ALSO be redirected straight
   * past the sign-in screen. */
  private authResultBody(user: E2EUser) {
    return {
      accessToken: `e2e-token-${user.id}`,
      expiresIn: 900,
      user: { id: user.id, fullName: user.fullName, roles: user.roles },
    };
  }

  /** The one place a session is issued, so `/auth/login`, `/auth/mfa/verify`,
   * `/auth/mfa/recovery` and the enrol-completes-login path cannot drift —
   * mirroring the api's own `SessionIssuerService`. */
  private async fulfillAuthenticated(route: Route, user: E2EUser) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Set-Cookie': `bf_refresh=e2e-refresh-${user.id}; Path=/; HttpOnly` },
      body: JSON.stringify(this.authResultBody(user)),
    });
  }

  /** Deliberately opaque, exactly as `invalidCredentialsProblem()` is: the
   * caller is never told whether the code, the challenge token or the account
   * was the problem. */
  private async fulfillInvalidCredentials(route: Route) {
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify(this.problem(401, 'Invalid credentials', '/errors/invalid-credentials')),
    });
  }

  private async handleLogin(route: Route) {
    const body = route.request().postDataJSON() as { email?: string; password?: string };
    const user = (body.email && this.userByEmail(body.email)) || this.adminUsers.get('user-1')!;

    // Slice 13-UI-B: a deactivated account cannot sign in — same opaque 401
    // as a wrong password (the real api never discloses WHICH it was).
    if (body.password !== this.passwordOf(user.id) || !user.active) {
      await this.fulfillInvalidCredentials(route);
      return;
    }

    // Slice 13-MFA §4: with the flag on, a user holding any MFA_REQUIRED_ROLE
    // gets NO access token and NO refresh cookie — only a challenge.
    // MAINTAINER is exempt, so the technician's flow is unchanged.
    const mfaRequired =
      this.mfaEnabled && user.roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
    if (!mfaRequired) {
      await this.fulfillAuthenticated(route, user);
      return;
    }

    const challengeToken = `mfa-challenge-${user.id}-${++this.challengeSeq}`;
    this.challenges.set(challengeToken, {
      userId: user.id,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // No Set-Cookie: the login is not finished.
      body: JSON.stringify({
        mfaRequired: true,
        mfaEnrolled: this.enrolledUserIds.has(user.id),
        challengeToken,
        expiresIn: Math.floor(CHALLENGE_TTL_MS / 1000),
      }),
    });
  }

  // ---- Slice 13-UI-A: /auth/mfa/*, /auth/password, /users/{id}/mfa-reset ----

  /** Resolves a challenge token to its user, enforcing expiry and single use.
   * Returns null for anything it will not honour. */
  private challengeSubject(challengeToken: string | undefined): E2EUser | null {
    if (!challengeToken) return null;
    if (this.consumedChallenges.has(challengeToken)) return null;
    const challenge = this.challenges.get(challengeToken);
    if (!challenge || Date.now() > challenge.expiresAt) return null;
    return this.adminUsers.get(challenge.userId) ?? null;
  }

  /** Burns a challenge token. The FIRST redemption wins; every later one —
   * including a replay of the exact same request — gets 401. */
  private consumeChallenge(challengeToken: string): void {
    this.consumedChallenges.add(challengeToken);
  }

  /** Either credential the enrol endpoints accept (openapi: `bearerAuth` OR
   * the body `challengeToken`). Never anonymous. */
  private async enrolSubject(
    route: Route,
    body: { challengeToken?: string },
  ): Promise<{ user: E2EUser; challengeToken?: string } | null> {
    if (body.challengeToken) {
      const user = this.challengeSubject(body.challengeToken);
      return user ? { user, challengeToken: body.challengeToken } : null;
    }
    const auth = (await route.request().headerValue('authorization')) ?? '';
    const match = auth.match(/Bearer e2e-token-(user-\d+)/);
    const user = match ? this.adminUsers.get(match[1]) : undefined;
    return user ? { user } : null;
  }

  private async handleMfaVerify(route: Route) {
    const body = route.request().postDataJSON() as {
      challengeToken?: string;
      totpCode?: string;
    };
    const user = this.challengeSubject(body.challengeToken);
    const secret = user ? this.confirmedSecrets.get(user.id) : undefined;
    if (!user || !secret || !this.enrolledUserIds.has(user.id)) {
      await this.fulfillInvalidCredentials(route);
      return;
    }

    const verification = verifyTotp(secret, body.totpCode ?? '', this.lastUsedStep.get(user.id));
    if (!verification.valid) {
      // A wrong code does NOT burn the challenge — the api only claims it on
      // a successful redemption — so the user gets to retype.
      this.rejectedTotpCodes.push(body.totpCode ?? '');
      await this.fulfillInvalidCredentials(route);
      return;
    }

    this.lastUsedStep.set(user.id, verification.step!);
    this.consumeChallenge(body.challengeToken!);
    await this.fulfillAuthenticated(route, user);
  }

  private async handleMfaRecovery(route: Route) {
    const body = route.request().postDataJSON() as {
      challengeToken?: string;
      recoveryCode?: string;
    };
    const user = this.challengeSubject(body.challengeToken);
    const codes = user ? this.recoveryCodes.get(user.id) : undefined;
    const normalised = normaliseRecoveryCode(body.recoveryCode ?? '');
    // Must exist, belong to this user, and be UNUSED. Marked used, never
    // deleted (INV-07), which is what makes a second attempt genuinely fail.
    if (!user || !codes || codes.get(normalised) !== false) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    codes.set(normalised, true);
    this.consumeChallenge(body.challengeToken!);
    await this.fulfillAuthenticated(route, user);
  }

  private async handleMfaEnrol(route: Route) {
    const body = route.request().postDataJSON() as { challengeToken?: string };
    const subject = await this.enrolSubject(route, body);
    if (!subject) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    if (this.enrolledUserIds.has(subject.user.id)) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Multi-factor authentication is already set up for this account',
            '/errors/conflict',
          ),
        ),
      });
      return;
    }
    // Re-calling before confirmation REPLACES the pending secret.
    const secret = randomBase32Secret();
    this.pendingSecrets.set(subject.user.id, secret);
    // Byte-for-byte what `api/src/auth/mfa/totp.ts#buildOtpauthUri` emits:
    // issuer and account name are encoded SEPARATELY, so the separator stays a
    // literal colon rather than becoming `%3A`. Both forms are legal under the
    // Key URI Format, but `qr-hand-check.spec.ts` is the one artefact a human
    // scans before MFA can be switched on, and it has to be validating the
    // string production actually produces (review finding m1).
    const label = `${encodeURIComponent('BamForm')}:${encodeURIComponent(subject.user.email)}`;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=BamForm&algorithm=SHA1&digits=6&period=30`,
      }),
    });
  }

  private async handleMfaEnrolConfirm(route: Route) {
    const body = route.request().postDataJSON() as {
      challengeToken?: string;
      totpCode?: string;
    };
    const subject = await this.enrolSubject(route, body);
    const pending = subject ? this.pendingSecrets.get(subject.user.id) : undefined;
    if (!subject || !pending) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    const verification = verifyTotp(
      pending,
      body.totpCode ?? '',
      this.lastUsedStep.get(subject.user.id),
    );
    if (!verification.valid) {
      this.rejectedTotpCodes.push(body.totpCode ?? '');
      await this.fulfillInvalidCredentials(route);
      return;
    }

    this.pendingSecrets.delete(subject.user.id);
    this.confirmedSecrets.set(subject.user.id, pending);
    this.enrolledUserIds.add(subject.user.id);
    this.lastUsedStep.set(subject.user.id, verification.step!);
    const codes = generateRecoveryCodes();
    this.recoveryCodes.set(
      subject.user.id,
      new Map(codes.map((c) => [normaliseRecoveryCode(c), false])),
    );

    // Confirming on a challenge token also COMPLETES the login (§4.4);
    // a voluntary enrolment returns `auth: null` and keeps its session.
    if (subject.challengeToken) {
      this.consumeChallenge(subject.challengeToken);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Set-Cookie': `bf_refresh=e2e-refresh-${subject.user.id}; Path=/; HttpOnly`,
        },
        body: JSON.stringify({
          recoveryCodes: codes,
          auth: this.authResultBody(subject.user),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recoveryCodes: codes, auth: null }),
    });
  }

  private async handlePasswordChange(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (body.currentPassword !== this.passwordOf(requester.id)) {
      await this.fulfillInvalidCredentials(route);
      return;
    }
    if ((body.newPassword ?? '').length < 12) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(422, 'Password must be at least 12 characters', '/errors/validation-failed'),
        ),
      });
      return;
    }
    this.passwords.set(requester.id, body.newPassword!);
    this.mustChangePassword.delete(requester.id);
    await route.fulfill({ status: 204, body: '' });
  }

  private async handleMfaReset(route: Route, userId: string) {
    const requester = await this.currentUser(route);
    if (!requester.roles.includes('ADMIN')) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'Forbidden', '/errors/forbidden')),
      });
      return;
    }
    if (!this.adminUsers.has(userId)) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Not found', '/errors/not-found')),
      });
      return;
    }
    this.enrolledUserIds.delete(userId);
    this.confirmedSecrets.delete(userId);
    this.pendingSecrets.delete(userId);
    this.lastUsedStep.delete(userId);
    const codes = this.recoveryCodes.get(userId);
    if (codes) for (const code of codes.keys()) codes.set(code, true);
    await route.fulfill({ status: 204, body: '' });
  }

  /**
   * The global, deny-by-default forced-password-change guard (slice 13-MFA
   * §7). Wrapped around every NON-auth route in `install()` so a route added
   * later inherits it, exactly as the server's `APP_GUARD` does — rather than
   * being remembered per handler.
   */
  private guarded(handler: (route: Route) => Promise<void>): (route: Route) => Promise<void> {
    return async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (!PASSWORD_CHANGE_ALLOWED_PATHS.some((allowed) => path.endsWith(allowed))) {
        const requester = await this.currentUser(route);
        if (this.mustChangePassword.has(requester.id)) {
          await route.fulfill({
            status: 403,
            contentType: 'application/problem+json',
            body: JSON.stringify(
              this.problem(403, 'Password change required', '/errors/password-change-required'),
            ),
          });
          return;
        }
      }
      await handler(route);
    };
  }

  private async handleRefresh(route: Route) {
    const cookieHeader = (await route.request().headerValue('cookie')) ?? '';
    const match = cookieHeader.match(/bf_refresh=e2e-refresh-(user-\d+)/);
    if (!match) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'no session', status: 401 }),
      });
      return;
    }
    const user = this.adminUsers.get(match[1]) ?? this.adminUsers.get('user-1')!;
    // Slice 13-UI-B: deactivation bites at the next refresh, exactly as the
    // real api enforces it — the cookie stops minting sessions.
    if (!user.active) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'account deactivated', status: 401 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: `e2e-token-${user.id}-refreshed`,
        expiresIn: 900,
        user: { id: user.id, fullName: user.fullName, roles: user.roles },
      }),
    });
  }

  private async handleBootstrap(route: Route) {
    // Slice 16 (SYS-6): the bootstrap payload's `user` is the AUTHENTICATED
    // principal, exactly as the real endpoint derives it from the bearer —
    // the client keys its whole offline partition on this id, so echoing a
    // hardcoded user here would silently undo the multi-user tests.
    const requester = await this.currentUser(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        serverTime: this.serverTime,
        user: { id: requester.id, fullName: requester.fullName, roles: requester.roles },
        // Slice 13-UI-B: the bootstrap is area-scoped exactly like the real
        // GET /jobs family (PR-API-10) — a scoped user's device never even
        // receives out-of-area jobs.
        jobs: Array.from(this.jobs.values())
          .filter((j) => this.jobInScope(requester, j))
          .map((j) => this.toApiJob(j)),
        deletedJobIds: Array.from(this.deletedJobIds),
        syncToken: `tok-${this.jobs.size}`,
      }),
    });
  }

  private async handleOutbox(route: Route) {
    this.outboxRequestCount++;
    const body = route.request().postDataJSON() as {
      mutations: Array<{
        id: string;
        path: string;
        ifMatch?: number | null;
        body?: unknown;
      }>;
    };
    this.receivedBatches.push(body.mutations.map((m) => ({ id: m.id, path: m.path })));

    if (this.networkDown) {
      await route.abort('internetdisconnected');
      return;
    }

    if (body.mutations.length > 200) {
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'batch too large',
          status: 400,
        }),
      });
      return;
    }

    const results: OutboxResultLike[] = [];
    let mustDrop = false;

    for (const m of body.mutations) {
      const existing = this.idempotencyStore.get(m.id);
      if (existing) {
        results.push(existing);
        continue;
      }
      const jobId = this.jobIdFromPath(m.path);
      const currentVersion = jobId ? this.draftVersionOf(jobId) : 1;
      const isStale = m.ifMatch != null && m.ifMatch !== currentVersion;
      const forcedConflict = this.conflictOnce.has(m.id) || this.forceNextConflict;
      const jobWasRemoved = jobId != null && this.deletedJobIds.has(jobId);

      let result: OutboxResultLike;
      if (jobWasRemoved) {
        // O-14: a mutation against a job that no longer exists/was
        // reassigned server-side is rejected, not silently applied — if it
        // were silently applied, the device's `hasPendingOutbox` flag would
        // clear on its own and the NEXT bootstrap would have nothing left
        // to protect, defeating the "device is informed, cannot submit"
        // guarantee this scenario is specifically about.
        result = {
          id: m.id,
          status: 404,
          applied: false,
          problem: { type: 'about:blank', title: 'job not found (reassigned)', status: 404 },
        };
      } else if (forcedConflict || isStale) {
        this.conflictOnce.delete(m.id);
        result = {
          id: m.id,
          status: 409,
          applied: false,
          problem: {
            type: 'https://form.bevorasg.com/errors/draft-conflict',
            title: 'Draft version conflict',
            status: 409,
            detail: isStale
              ? `Job is at draftVersion ${currentVersion}, mutation based on ${m.ifMatch}`
              : undefined,
          },
        };
      } else if (m.path.endsWith('/title-machine-number')) {
        // Slice 31-TITLEBLANK. Validated against the REAL schema, not a
        // paraphrase (same rule as `assetDocumentUpdateSchema` above): the
        // server rejects `''` outright, so a client that ever sent one must
        // fail here rather than sail through a fake that normalises it.
        const parsed = titleMachineNumberInputSchema.safeParse(m.body ?? {});
        if (!parsed.success) {
          result = {
            id: m.id,
            status: 422,
            applied: false,
            problem: {
              type: 'https://form.bevorasg.com/errors/validation-failed',
              title: 'Validation failed',
              status: 422,
            },
          };
        } else {
          this.appliedCount.set(m.id, (this.appliedCount.get(m.id) ?? 0) + 1);
          // Deliberately does NOT bump `draftVersion`: this route is
          // unversioned server-side (`title-machine-number.service.ts`), and a
          // fake that bumped it would hide a client which wrongly predicted
          // a version for it.
          if (jobId) this.jobTitleMachineNumber.set(jobId, parsed.data.titleMachineNumber);
          result = { id: m.id, status: 200, applied: true };
        }
      } else {
        this.appliedCount.set(m.id, (this.appliedCount.get(m.id) ?? 0) + 1);
        if (jobId) this.draftVersions.set(jobId, currentVersion + 1);
        result = { id: m.id, status: 200, applied: true };
      }
      this.idempotencyStore.set(m.id, result);
      results.push(result);
      if (this.dropResponseOnce.has(m.id)) {
        this.dropResponseOnce.delete(m.id);
        mustDrop = true;
      }
    }
    this.forceNextConflict = false;

    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      mustDrop = true;
    }

    if (mustDrop) {
      await route.abort('internetdisconnected'); // commit already happened above — O-15 fault
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, syncToken: `tok-${this.idempotencyStore.size}` }),
    });
  }

  private async handleSubmit(route: Route, jobId: string) {
    // Slice 18-WORKFLOW §1 — the real server REFUSES an unsigned submission
    // (422), so the fake does too: a screen that stops capturing the
    // performer's signature must fail the offline suite, not sail through it.
    const submitBody = route.request().postDataJSON() as { drawnSignature?: string } | null;
    if (!submitBody?.drawnSignature) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: '/errors/validation-failed',
          title: 'Validation failed',
          status: 422,
          detail: 'drawnSignature is required (base64 PNG data-URL).',
        }),
      });
      return;
    }
    // Slice 31-TITLEBLANK — the real server refuses a submission whose title
    // carries a blank that was never filled (422 `/errors/incomplete-record`,
    // pointer `/titleMachineNumber`), so the fake does too: a screen that
    // stops capturing it must fail the suite rather than sail through.
    //
    // Review M-4: this is checked before the idempotency replay only because
    // it is simpler to write that way. The REAL ordering is the opposite —
    // `submission.service.ts` checks the replay first, then loads the job,
    // then the outstanding-items gate, then this one. The difference is not
    // observable: a refused submission never reaches `recordWithin`, so no
    // replay entry for it can exist to be returned early.
    const seededJob = this.jobs.get(jobId);
    if (
      seededJob &&
      titleHasFillableRun(this.titleOf(seededJob)) &&
      !this.titleMachineNumberOf(seededJob)
    ) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: '/errors/incomplete-record',
          title: 'Record is incomplete',
          status: 422,
          detail: `The form number in the title has not been filled in — "${this.titleOf(seededJob)}".`,
          errors: [
            {
              pointer: '/titleMachineNumber',
              code: 'REQUIRED',
              message: 'Form number in the title is required',
            },
          ],
        }),
      });
      return;
    }
    const key = await route.request().headerValue('idempotency-key');
    const dedupeKey = key ?? jobId;
    if (this.submitStore.has(dedupeKey)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(this.submitStore.get(dedupeKey)),
      });
      return;
    }
    this.submitCount.set(jobId, (this.submitCount.get(jobId) ?? 0) + 1);
    const job = this.jobs.get(jobId);
    if (job) {
      const requester = await this.currentUser(route);
      this.jobStatus.set(jobId, 'SUBMITTED');
      this.jobStageOrdinal.set(jobId, 1);
      this.jobSubmittedBy.set(jobId, requester.id);
      this.jobSubmittedAt.set(jobId, new Date().toISOString());
      const steps = this.approvalSteps.get(jobId) ?? [];
      steps.push({
        id: `step-${++this.approvalStepSeq}`,
        stageOrdinal: 0,
        stageLabel: 'Submitted',
        action: 'SUBMITTED',
        actorId: requester.id,
        actorName: requester.fullName,
        actedAt: this.jobSubmittedAt.get(jobId)!,
      });
      this.approvalSteps.set(jobId, steps);
    }
    const body = job ? this.toApiJob(job) : { id: jobId, status: 'SUBMITTED' };
    this.submitStore.set(dedupeKey, body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }

  /**
   * Slice 18-WORKFLOW §2 — `POST /jobs/adhoc` (UR-028). Mirrors the real
   * endpoint's contract that the SCREEN depends on: the role gate, the
   * mandatory >= 10-character reason, and a job that appears in the caller's
   * list like any other. It also mirrors the property the whole slice turns
   * on — `frequencyScope: []`, the marker that says this job credits no
   * schedule period.
   */
  private async handleCreateAdhocJob(route: Route): Promise<void> {
    const requester = await this.requireRoles(route, [
      'PLANNER',
      'TEAM_LEADER',
      'ENGINEER',
      'ADMIN',
    ]);
    if (!requester) return;
    const body = route.request().postDataJSON() as {
      assetId?: string;
      assetDocumentId?: string;
      frequency?: 'M1' | 'M3' | 'M6' | 'Y';
      reason?: string;
      dueOn?: string;
    };
    const asset = body.assetId ? this.assetsById.get(body.assetId) : undefined;
    if (!asset) {
      await this.fulfillProblem(route, 404, 'Not found', '/errors/not-found');
      return;
    }
    if (!body.reason || body.reason.trim().length < 10) {
      await this.fulfillProblem(route, 422, 'Validation failed', '/errors/validation-failed');
      return;
    }
    // Slice 27-ASSETDOC — the checklist comes from a DOCUMENT tagged to the
    // machine. `adhoc-job.service.ts`'s three refusals, mirrored: no active
    // document at all, a document that is not this machine's, and several
    // documents with none named. The picker exists to make all three
    // unreachable from the UI; the fake server keeps them reachable so the
    // journey can prove the screen never provokes them.
    const activeDocuments = this.documentsOf(asset.id).filter((doc) => doc.active);
    if (activeDocuments.length === 0) {
      await this.fulfillProblem(
        route,
        422,
        'Validation failed',
        '/errors/validation-failed',
        'This machine carries no active preventive-maintenance document — an admin must tag one before work can be raised against it.',
      );
      return;
    }
    if (body.assetDocumentId) {
      if (!activeDocuments.some((doc) => doc.id === body.assetDocumentId)) {
        await this.fulfillProblem(
          route,
          422,
          'Validation failed',
          '/errors/validation-failed',
          `Document ${body.assetDocumentId} is not an active document of this machine.`,
        );
        return;
      }
    } else if (activeDocuments.length > 1) {
      await this.fulfillProblem(
        route,
        422,
        'Validation failed',
        '/errors/validation-failed',
        `This machine carries ${activeDocuments.length} documents — name the one this work is recorded on with \`assetDocumentId\`.`,
      );
      return;
    }
    const id = `adhoc-${++this.adhocSeq}`;
    const job: SeedJob = {
      id,
      jobNumber: `PM-2026-${String(900000 + this.adhocSeq)}`,
      assetCode: asset.code,
      frequency: body.frequency ?? 'M1',
      dueOn: body.dueOn ?? new Date().toISOString().slice(0, 10),
      status: 'SCHEDULED',
      items: [{ id: `${id}-item-1`, itemNo: 1, instruction: 'Ad-hoc check', mandatory: true }],
    };
    this.seedJob(job);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ...this.toApiJob(job), frequencyScope: [] }),
    });
  }

  private adhocSeq = 0;

  // ---- Slice 16 (D-2b): attachments — online-only upload ----

  attachments = new Map<string, Array<{ id: string; originalFilename: string }>>();
  private attachmentIdempotency = new Map<string, unknown>();
  private attachmentSeq = 0;
  private uploadRejectionOnce: { status: number; title: string } | null = null;

  /** The NEXT upload is refused with this Problem (e.g. magic-byte 422). */
  forceNextUploadRejectionOnce(status: number, title: string): void {
    this.uploadRejectionOnce = { status, title };
  }

  private async handleUploadAttachment(route: Route, jobId: string) {
    if (this.networkDown) {
      await route.abort('internetdisconnected');
      return;
    }
    const key = await route.request().headerValue('idempotency-key');
    if (!key) {
      // The contract REQUIRES the header — a client that forgets it must
      // fail loudly in the suite, not silently pass.
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(422, 'Idempotency-Key is required')),
      });
      return;
    }
    const replay = this.attachmentIdempotency.get(key);
    if (replay) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(replay),
      });
      return;
    }
    if (this.uploadRejectionOnce) {
      const { status, title } = this.uploadRejectionOnce;
      this.uploadRejectionOnce = null;
      await route.fulfill({
        status,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(status, title, 'https://form.bevorasg.com/errors/attachment-rejected'),
        ),
      });
      return;
    }
    const attachment = {
      id: `att-${++this.attachmentSeq}`,
      itemResultId: null,
      originalFilename: `photo-${this.attachmentSeq}.jpg`,
      contentType: 'image/jpeg',
      byteSize: route.request().postDataBuffer()?.length ?? 0,
      uploadState: 'received',
    };
    const list = this.attachments.get(jobId) ?? [];
    list.push(attachment);
    this.attachments.set(jobId, list);
    this.attachmentIdempotency.set(key, attachment);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(attachment),
    });
  }

  // ---- Slice 11a/11b: verifier queue / record review / delegations ----

  private async handleGetJob(route: Route, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Job not found')),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleQueue(route: Route) {
    const requester = await this.currentUser(route);
    const now = Date.now();
    const activeDelegationsToMe = Array.from(this.delegations.values()).filter(
      (d) =>
        d.delegateId === requester.id &&
        !d.revokedAt &&
        Date.parse(d.validFrom) <= now &&
        now <= Date.parse(d.validTo),
    );

    const data: unknown[] = [];
    for (const job of this.jobs.values()) {
      if ((this.jobStatus.get(job.id) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') continue;
      // Slice 13-UI-B (PR-API-10): a scoped verifier's queue only carries
      // their areas' jobs — the read-side enforcement E-06 proves end-to-end.
      if (!this.jobInScope(requester, job)) continue;
      const submitter = this.jobSubmittedBy.get(job.id);
      if (submitter === requester.id) continue; // INV-05: never your own submission
      const stage = this.jobStageOrdinal.get(job.id) ?? 1;
      const stageRole = this.currentStageRole(stage);

      let onBehalfOf: string | null = null;
      const eligible = requester.roles.includes(stageRole);
      if (!eligible) {
        const viaDelegation = activeDelegationsToMe.find((d) => {
          const delegator = this.adminUsers.get(d.delegatorId);
          return delegator?.roles.includes(stageRole);
        });
        if (!viaDelegation) continue;
        onBehalfOf = viaDelegation.delegatorId;
      }

      const submittedAt = this.jobSubmittedAt.get(job.id) ?? new Date().toISOString();
      data.push({
        ...this.toApiJob(job),
        submittedAt,
        submittedByName: submitter
          ? (this.adminUsers.get(submitter)?.fullName ?? submitter)
          : undefined,
        ageHours: (now - Date.parse(submittedAt)) / 3_600_000,
        escalated: false,
        onBehalfOf,
        // Slice 26-TWOSTAGE — the queue tells a verifier which of the
        // route's stages the record awaits.
        stageOrdinal: stage,
        stageCount: 2,
        stageLabel: this.currentStageLabel(stage),
      });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, limit: 50, nextCursor: null } }),
    });
  }

  private async handleVerify(route: Route, jobId: string) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      drawnSignature?: string;
      onBehalfOf?: string | null;
      comment?: string | null;
    };

    if (!body.drawnSignature) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            422,
            'drawnSignature is required (base64 PNG data-URL).',
            'https://form.bevorasg.com/errors/attachment-rejected',
          ),
        ),
      });
      return;
    }

    // PR-API-07: step-up is required per signing action, per user — a
    // fresh login does NOT itself satisfy it in this fake (see the
    // `stepUpValidUserIds` field doc).
    if (!this.stepUpValidUserIds.has(requester.id)) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            403,
            'Re-authentication required before signing',
            'https://form.bevorasg.com/errors/step-up-required',
          ),
        ),
      });
      return;
    }

    const job = this.jobs.get(jobId);
    if (!job || (this.jobStatus.get(jobId) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Job is not SUBMITTED',
            'https://form.bevorasg.com/errors/invalid-transition',
          ),
        ),
      });
      return;
    }

    const submitter = this.jobSubmittedBy.get(jobId);
    if (!body.onBehalfOf && submitter === requester.id) {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(
            409,
            'Self-approval is not permitted',
            'https://form.bevorasg.com/errors/self-approval',
          ),
        ),
      });
      return;
    }

    const stage = this.jobStageOrdinal.get(jobId) ?? 1;
    const stageRole = this.currentStageRole(stage);
    let actingRoles = requester.roles as readonly string[];
    let onBehalfOfName: string | null = null;
    if (body.onBehalfOf) {
      const now = Date.now();
      const delegation = Array.from(this.delegations.values()).find(
        (d) =>
          d.delegatorId === body.onBehalfOf &&
          d.delegateId === requester.id &&
          !d.revokedAt &&
          Date.parse(d.validFrom) <= now &&
          now <= Date.parse(d.validTo),
      );
      if (!delegation) {
        await route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          body: JSON.stringify(
            this.problem(403, 'No active delegation permits acting on behalf of that user'),
          ),
        });
        return;
      }
      const delegator = this.adminUsers.get(body.onBehalfOf);
      actingRoles = delegator?.roles ?? [];
      onBehalfOfName = delegator?.fullName ?? body.onBehalfOf;
    }

    if (!actingRoles.includes(stageRole)) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }

    // Consumed by this signing action — the NEXT verify by this same user
    // (e.g. stage 2, or a different job) requires stepping up again.
    this.stepUpValidUserIds.delete(requester.id);

    const steps = this.approvalSteps.get(jobId) ?? [];
    steps.push({
      id: `step-${++this.approvalStepSeq}`,
      stageOrdinal: stage,
      stageLabel: stage >= 2 ? 'Verified By (Engineer)' : 'Verified By (Workshop Team Leader)',
      action: 'VERIFIED',
      actorId: requester.id,
      actorName: requester.fullName,
      actorRoleCode: stageRole,
      onBehalfOfName,
      actedAt: new Date().toISOString(),
    });
    this.approvalSteps.set(jobId, steps);

    if (stage >= 2) {
      this.jobStatus.set(jobId, 'ARCHIVED');
    } else {
      this.jobStageOrdinal.set(jobId, 2);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleReturn(route: Route, jobId: string) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as { reason?: string };
    if (!body.reason || body.reason.trim().length < 10) {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify(
          this.problem(422, 'reason must be at least 10 characters (INV-13, PR-074).'),
        ),
      });
      return;
    }
    const job = this.jobs.get(jobId);
    if (!job || (this.jobStatus.get(jobId) ?? job.status ?? 'IN_PROGRESS') !== 'SUBMITTED') {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(409, 'Job is not SUBMITTED')),
      });
      return;
    }

    this.jobStatus.set(jobId, 'IN_PROGRESS');
    this.jobStageOrdinal.set(jobId, 1);
    const steps = this.approvalSteps.get(jobId) ?? [];
    steps.push({
      id: `step-${++this.approvalStepSeq}`,
      stageOrdinal: this.jobStageOrdinal.get(jobId) ?? 1,
      stageLabel: 'Returned',
      action: 'RETURNED',
      actorId: requester.id,
      actorName: requester.fullName,
      reason: body.reason,
      actedAt: new Date().toISOString(),
    });
    this.approvalSteps.set(jobId, steps);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  private async handleStepUp(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as { password?: string };
    if (body.password !== E2E_PASSWORD) {
      await route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(401, 'Incorrect password')),
      });
      return;
    }
    this.stepUpValidUserIds.add(requester.id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stepUpValidUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
  }

  private async handleListDelegations(route: Route) {
    const requester = await this.currentUser(route);
    const data = Array.from(this.delegations.values())
      .filter((d) => d.delegatorId === requester.id || d.delegateId === requester.id)
      .map((d) => this.toApiDelegation(d));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, page: { hasMore: false, limit: 50, nextCursor: null } }),
    });
  }

  private toApiDelegation(d: FakeDelegation) {
    return {
      ...d,
      delegatorName: this.adminUsers.get(d.delegatorId)?.fullName,
      delegateName: this.adminUsers.get(d.delegateId)?.fullName,
    };
  }

  private async handleCreateDelegation(route: Route) {
    const requester = await this.currentUser(route);
    const body = route.request().postDataJSON() as {
      delegatorId: string;
      delegateId: string;
      validFrom: string;
      validTo: string;
      reason?: string | null;
    };

    // Mirrors the real permission matrix (§4.1): a TEAM_LEADER/ENGINEER may
    // only delegate their OWN authority away; only ADMIN may set up a
    // delegation between two other users (no ADMIN exists among the canned
    // E2E_USERS, so that branch never applies here).
    const canDelegate = requester.roles.some((r) => r === 'TEAM_LEADER' || r === 'ENGINEER');
    if (!canDelegate || body.delegatorId !== requester.id) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }

    const delegation = this.seedDelegation(body);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiDelegation(delegation)),
    });
  }

  private async handleRevokeDelegation(route: Route, delegationId: string) {
    const requester = await this.currentUser(route);
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(404, 'Delegation not found')),
      });
      return;
    }
    const canRevoke =
      delegation.delegatorId === requester.id || delegation.createdBy === requester.id;
    if (!canRevoke) {
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify(this.problem(403, 'forbidden')),
      });
      return;
    }
    if (!delegation.revokedAt) {
      delegation.revokedAt = new Date().toISOString();
      this.delegations.set(delegationId, delegation);
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiDelegation(delegation)),
    });
  }

  // ---- Slice 13-UI-B: users / roles / areas / asset-types / assets ----
  //
  // Honesty rule (the C-1 postmortem, slice-13-ui-a-review.md): every one of
  // these handlers enforces what the REAL endpoint enforces — a missing
  // bearer is 401 (no silent technician fallback like the legacy
  // `currentUser` default the offline suite depends on), a non-ADMIN is 403,
  // the last-admin self-lockout is 409 with the server's own sentence, and
  // reads are area-scoped. A permissive fake here would hide exactly the
  // client bugs this slice exists to not ship.

  /** PR-API-10, mirrored: no scopes = unrestricted; scoped = only their areas. */
  private jobInScope(requester: FakeAdminUser, job: SeedJob): boolean {
    if (requester.areaIds.length === 0) return true;
    return job.areaId != null && requester.areaIds.includes(job.areaId);
  }

  private async fulfillProblem(
    route: Route,
    status: number,
    title: string,
    type = 'about:blank',
    detail?: string,
  ): Promise<void> {
    await route.fulfill({
      status,
      contentType: 'application/problem+json',
      body: JSON.stringify({ type, title, status, ...(detail ? { detail } : {}) }),
    });
  }

  /** Strict bearer check — 401s and returns null when absent/unparseable. */
  private async requireUser(route: Route): Promise<FakeAdminUser | null> {
    const auth = (await route.request().headerValue('authorization')) ?? '';
    const match = auth.match(/Bearer e2e-token-(user-\d+)/);
    const user = match ? this.adminUsers.get(match[1]) : undefined;
    if (!user) {
      await this.fulfillProblem(route, 401, 'Unauthenticated');
      return null;
    }
    return user;
  }

  private async requireRoles(route: Route, roles: string[]): Promise<FakeAdminUser | null> {
    const user = await this.requireUser(route);
    if (!user) return null;
    if (!user.roles.some((r) => roles.includes(r))) {
      await this.fulfillProblem(route, 403, 'Forbidden', '/errors/forbidden');
      return null;
    }
    return user;
  }

  private toApiUser(user: FakeAdminUser) {
    return {
      id: user.id,
      employeeId: user.employeeId,
      fullName: user.fullName,
      email: user.email,
      status: user.active ? 'ACTIVE' : 'DEACTIVATED',
      active: user.active,
      roles: user.roles,
      areaIds: user.areaIds,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private page<T>(data: T[]) {
    return { data, page: { hasMore: false, limit: 100, nextCursor: null } };
  }

  private async handleListUsers(route: Route): Promise<void> {
    const requester = await this.requireRoles(route, ['ADMIN']);
    if (!requester) return;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        this.page(Array.from(this.adminUsers.values()).map((u) => this.toApiUser(u))),
      ),
    });
  }

  private async handleGetUser(route: Route, userId: string): Promise<void> {
    const requester = await this.requireRoles(route, ['ADMIN']);
    if (!requester) return;
    const user = this.adminUsers.get(userId);
    if (!user) {
      await this.fulfillProblem(route, 404, 'User not found', '/errors/not-found');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiUser(user)),
    });
  }

  private async handleCreateUser(route: Route): Promise<void> {
    const requester = await this.requireRoles(route, ['ADMIN']);
    if (!requester) return;
    const body = route.request().postDataJSON() as {
      fullName?: string;
      email?: string;
      employeeId?: string;
      password?: string;
      roleCodes?: string[];
    };
    const validRoleCodes = FAKE_ROLES.map((r) => r.code);
    if (
      !body.fullName?.trim() ||
      !body.email?.trim() ||
      (body.password ?? '').length < 12 ||
      !body.roleCodes?.length ||
      body.roleCodes.some((code) => !validRoleCodes.includes(code))
    ) {
      await this.fulfillProblem(route, 422, 'Validation failed', '/errors/validation-failed');
      return;
    }
    if (this.userByEmail(body.email.trim())) {
      await this.fulfillProblem(
        route,
        409,
        'Conflict',
        '/errors/conflict',
        'A user with this email already exists.',
      );
      return;
    }
    const now = new Date().toISOString();
    const user: FakeAdminUser = {
      id: `user-${++this.userSeq}`,
      email: body.email.trim(),
      fullName: body.fullName.trim(),
      roles: [...body.roleCodes],
      active: true,
      employeeId: body.employeeId?.trim() || null,
      areaIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.adminUsers.set(user.id, user);
    // The admin-set password is the credential the new user signs in with —
    // FORCE_PASSWORD_CHANGE_ENABLED is off (production default), so no
    // must-change latch is set here, matching the real create path.
    this.passwords.set(user.id, body.password!);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiUser(user)),
    });
  }

  private async handlePatchUser(route: Route, userId: string): Promise<void> {
    const requester = await this.requireRoles(route, ['ADMIN']);
    if (!requester) return;
    const target = this.adminUsers.get(userId);
    if (!target) {
      await this.fulfillProblem(route, 404, 'User not found', '/errors/not-found');
      return;
    }
    const body = route.request().postDataJSON() as {
      fullName?: string;
      email?: string;
      active?: boolean;
      roleCodes?: string[];
    };

    // SYS-11 last-admin guard, byte-for-byte the same refusal the real
    // `users.service.ts#update` raises — the screen shows this sentence.
    const isSelfDeactivation = target.id === requester.id && body.active === false;
    const dropsOwnAdmin =
      target.id === requester.id &&
      body.roleCodes !== undefined &&
      target.roles.includes('ADMIN') &&
      !body.roleCodes.includes('ADMIN');
    if (isSelfDeactivation || dropsOwnAdmin) {
      const otherActiveAdmin = Array.from(this.adminUsers.values()).some(
        (u) => u.id !== target.id && u.active && u.roles.includes('ADMIN'),
      );
      if (!otherActiveAdmin) {
        await this.fulfillProblem(
          route,
          409,
          'Conflict',
          '/errors/conflict',
          'You are the last active ADMIN — deactivating yourself or dropping your own ADMIN role would lock all administrative access out of the system (SYS-11). Create another active ADMIN first.',
        );
        return;
      }
    }

    if (body.email !== undefined) {
      const existing = this.userByEmail(body.email.trim());
      if (existing && existing.id !== target.id) {
        await this.fulfillProblem(
          route,
          409,
          'Conflict',
          '/errors/conflict',
          'A user with this email already exists.',
        );
        return;
      }
      target.email = body.email.trim();
    }
    if (body.fullName !== undefined) target.fullName = body.fullName.trim();
    if (body.active !== undefined) target.active = body.active;
    if (body.roleCodes !== undefined) target.roles = [...body.roleCodes];
    target.updatedAt = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiUser(target)),
    });
  }

  private async handleSetUserAreaScopes(route: Route, userId: string): Promise<void> {
    const requester = await this.requireRoles(route, ['ADMIN']);
    if (!requester) return;
    const target = this.adminUsers.get(userId);
    if (!target) {
      await this.fulfillProblem(route, 404, 'User not found', '/errors/not-found');
      return;
    }
    const body = route.request().postDataJSON() as { areaIds?: string[] };
    if (!Array.isArray(body.areaIds)) {
      await this.fulfillProblem(route, 422, 'Validation failed', '/errors/validation-failed');
      return;
    }
    const unknown = body.areaIds.filter((id) => !this.areasById.has(id));
    if (unknown.length > 0) {
      await this.fulfillProblem(
        route,
        422,
        'Validation failed',
        '/errors/validation-failed',
        'One or more areaIds do not match a known area.',
      );
      return;
    }
    // Review B-4 — same rule as `users.service.ts#setAreaScopes`: a NEW
    // assignment to a deactivated area is refused; standing scopes on a
    // later-deactivated area are untouched.
    const inactive = body.areaIds.filter((id) => this.areasById.get(id)?.active === false);
    if (inactive.length > 0) {
      await this.fulfillProblem(
        route,
        422,
        'Validation failed',
        '/errors/validation-failed',
        `One or more areaIds refer to a deactivated area (${inactive
          .map((id) => this.areasById.get(id)?.code ?? id)
          .join(', ')}). Reactivate the area first, or scope to an active one.`,
      );
      return;
    }
    target.areaIds = [...new Set(body.areaIds)];
    target.updatedAt = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiUser(target)),
    });
  }

  private async handleListRoles(route: Route): Promise<void> {
    const requester = await this.requireUser(route);
    if (!requester) return;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(FAKE_ROLES)),
    });
  }

  private async handleAreas(route: Route): Promise<void> {
    if (route.request().method() === 'POST') {
      const requester = await this.requireRoles(route, ['ADMIN']);
      if (!requester) return;
      const body = route.request().postDataJSON() as { code?: string; name?: string };
      if (!body.code?.trim() || !body.name?.trim()) {
        await this.fulfillProblem(route, 422, 'Validation failed', '/errors/validation-failed');
        return;
      }
      const duplicate = Array.from(this.areasById.values()).some(
        (a) => a.code === body.code!.trim(),
      );
      if (duplicate) {
        await this.fulfillProblem(
          route,
          409,
          'Conflict',
          '/errors/conflict',
          `An area with code '${body.code.trim()}' already exists.`,
        );
        return;
      }
      const area = this.seedArea({ code: body.code.trim(), name: body.name.trim() });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(area),
      });
      return;
    }
    const requester = await this.requireUser(route);
    if (!requester) return;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(Array.from(this.areasById.values()))),
    });
  }

  private async handlePatchArea(route: Route, areaId: string): Promise<void> {
    const requester = await this.requireRoles(route, ['ADMIN']);
    if (!requester) return;
    const area = this.areasById.get(areaId);
    if (!area) {
      await this.fulfillProblem(route, 404, 'Area not found', '/errors/not-found');
      return;
    }
    const body = route.request().postDataJSON() as { name?: string; active?: boolean };
    if (body.name !== undefined) area.name = body.name.trim();
    if (body.active !== undefined) area.active = body.active;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(area),
    });
  }

  private async handleListAssetTypes(route: Route): Promise<void> {
    const requester = await this.requireUser(route);
    if (!requester) return;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(Array.from(this.assetTypesById.values()))),
    });
  }

  private toApiAsset(asset: FakeAsset) {
    return { ...asset, assetTypeName: this.assetTypesById.get(asset.assetTypeId)?.name };
  }

  // ---- Slice 28-ASSETDOC-UI: `/templates` and a machine's documents ----

  /** Mirrors `shared/src/template-title.ts` — a run of TWO OR MORE
   * underscores is the blank; a single underscore is punctuation. Derived
   * here for the same reason the real api derives it: it is SERVER truth, and
   * the client under test must never compute it for itself. */
  private static readonly FILLABLE_RUN = /_{2,}/;

  private toApiAssetDocument(doc: FakeAssetDocument) {
    const template = this.templatesById.get(doc.formTemplateId);
    const title = template?.title ?? '';
    return {
      id: doc.id,
      assetId: doc.assetId,
      formTemplateId: doc.formTemplateId,
      documentNumber: template?.documentNumber ?? '',
      title,
      resolvedTitle: doc.machineNumber
        ? title.replace(FakeServer.FILLABLE_RUN, () => doc.machineNumber as string)
        : title,
      titleHasFillableRun: FakeServer.FILLABLE_RUN.test(title),
      machineNumber: doc.machineNumber,
      active: doc.active,
    };
  }

  /**
   * The exact body `ZodValidationPipe` produces (`api/src/common/zod-validation
   * .pipe.ts` → `zodErrorToValidationProblem`), down to the detail string —
   * which is the whole point: it names no field and offers no remedy, so a
   * screen that provokes it leaves the user with nothing to act on. Review
   * M-1 was exactly that, and this is what the client now has to survive.
   */
  private async fulfillValidationFailed(route: Route): Promise<void> {
    await this.fulfillProblem(
      route,
      422,
      'Validation failed',
      '/errors/validation-failed',
      'Request body failed validation.',
    );
  }

  private documentsOf(assetId: string): FakeAssetDocument[] {
    return Array.from(this.assetDocumentsById.values()).filter((doc) => doc.assetId === assetId);
  }

  private async handleListTemplates(route: Route): Promise<void> {
    const requester = await this.requireUser(route);
    if (!requester) return;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(Array.from(this.templatesById.values()))),
    });
  }

  /**
   * `GET` carries NO role gate (it is the maintainer's form picker — slice 27
   * `asset-documents.controller.ts`); `POST` is ENGINEER-or-ADMIN, matching
   * `POST /assets`. Both are area-scoped, and an out-of-scope machine answers
   * an explicit 403, never a silent empty list.
   */
  private async handleAssetDocuments(route: Route, assetId: string): Promise<void> {
    const isPost = route.request().method() === 'POST';
    const requester = isPost
      ? await this.requireRoles(route, ['ENGINEER', 'ADMIN'])
      : await this.requireUser(route);
    if (!requester) return;
    const asset = this.assetsById.get(assetId);
    if (!asset) {
      await this.fulfillProblem(route, 404, 'Asset not found', '/errors/not-found');
      return;
    }
    if (!this.assetInScope(requester, asset)) {
      await this.fulfillProblem(route, 403, 'Out of scope', '/errors/out-of-scope');
      return;
    }
    if (!isPost) {
      // Deactivated documents are LISTED, not hidden — a machine's history
      // stays visible; it is the scheduler that stops raising work for them.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: this.documentsOf(assetId).map((d) => this.toApiAssetDocument(d)),
        }),
      });
      return;
    }
    // The api's `ZodValidationPipe` runs BEFORE anything else in the handler.
    const parsed = assetDocumentCreateSchema.safeParse(route.request().postDataJSON());
    if (!parsed.success) {
      await this.fulfillValidationFailed(route);
      return;
    }
    const body = parsed.data;
    const template = body.formTemplateId ? this.templatesById.get(body.formTemplateId) : undefined;
    if (!template) {
      await this.fulfillProblem(route, 404, 'Form template not found', '/errors/not-found');
      return;
    }
    if (this.documentsOf(assetId).some((d) => d.formTemplateId === template.id)) {
      await this.fulfillProblem(
        route,
        409,
        'Conflict',
        '/errors/conflict',
        `This machine already carries document ${template.documentNumber}.`,
      );
      return;
    }
    const doc = this.seedAssetDocument({
      assetId,
      formTemplateId: template.id,
      machineNumber: body.machineNumber ?? null,
    });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiAssetDocument(doc)),
    });
  }

  /** `PATCH /asset-documents/{id}` — ENGINEER or ADMIN. There is no DELETE:
   * `active: false` is the only removal (INV-16). */
  private async handlePatchAssetDocument(route: Route, id: string): Promise<void> {
    const requester = await this.requireRoles(route, ['ENGINEER', 'ADMIN']);
    if (!requester) return;
    const doc = this.assetDocumentsById.get(id);
    if (!doc) {
      await this.fulfillProblem(route, 404, 'Asset document not found', '/errors/not-found');
      return;
    }
    const asset = this.assetsById.get(doc.assetId);
    if (!asset || !this.assetInScope(requester, asset)) {
      await this.fulfillProblem(route, 403, 'Out of scope', '/errors/out-of-scope');
      return;
    }
    // Review M-2: this used to normalise `'' -> null` on its own authority.
    // The real schema is `.trim().min(1).max(50).nullable().optional()` — `''`
    // is REFUSED, and only `null` clears the blank. Parsing with the api's own
    // schema means the fake can no longer invent behaviour the server has not
    // got, which is the only reason M-1 survived a full green battery.
    const parsed = assetDocumentUpdateSchema.safeParse(route.request().postDataJSON());
    if (!parsed.success) {
      await this.fulfillValidationFailed(route);
      return;
    }
    const body = parsed.data;
    if (body.machineNumber !== undefined) doc.machineNumber = body.machineNumber;
    if (body.active !== undefined) doc.active = body.active;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiAssetDocument(doc)),
    });
  }

  /**
   * `assetDocument.active` filtered exactly like `AssetScheduleService.list`'s
   * `where` — a retired document's rules never appear here, though the rows
   * themselves are kept (returning the document to service brings them
   * straight back). Same `orderBy` as the service too: `assetDocumentId`
   * ascending, then `intervalMonths` ascending.
   */
  private scheduleRulesOf(assetId: string): FakeScheduleRule[] {
    const activeDocIds = new Set(
      this.documentsOf(assetId)
        .filter((d) => d.active)
        .map((d) => d.id),
    );
    return Array.from(this.scheduleRulesById.values())
      .filter((r) => activeDocIds.has(r.assetDocumentId))
      .sort((a, b) =>
        a.assetDocumentId === b.assetDocumentId
          ? a.intervalMonths - b.intervalMonths
          : a.assetDocumentId.localeCompare(b.assetDocumentId),
      );
  }

  /** Mirrors `toDto` in `asset-schedule.service.ts`: `assetId` is DERIVED
   * from the document, not stored on the rule. */
  private toApiScheduleRule(rule: FakeScheduleRule) {
    const doc = this.assetDocumentsById.get(rule.assetDocumentId);
    return {
      id: rule.id,
      assetDocumentId: rule.assetDocumentId,
      assetId: doc?.assetId ?? 'unknown',
      frequency: rule.frequency,
      intervalMonths: rule.intervalMonths,
      anchorDate: rule.anchorDate,
      lastCompletedOn: rule.lastCompletedOn,
      nextDueOn: rule.nextDueOn,
      adjustedReason: rule.adjustedReason,
      active: rule.active,
    };
  }

  /**
   * `GET`/`PUT /assets/{assetId}/schedule` — `asset-schedule.controller.ts`.
   * `GET` carries NO role gate (every authenticated user may read it, area
   * scope aside, since slice 5); `PUT` is PLANNER/TEAM_LEADER/ENGINEER/ADMIN,
   * matching the controller's `@Roles(...)` exactly. The `GET` body is a BARE
   * ARRAY — no `{data, page}` envelope, matching `scheduleRuleSchema`'s array
   * and `AssetScheduleService.list`'s `Promise<ScheduleRule[]>` return type —
   * a small, fixed-cardinality set scoped to one machine, same as
   * `listAssetDocuments`, not a paginated collection.
   */
  private async handleAssetSchedule(route: Route, assetId: string): Promise<void> {
    const isPut = route.request().method() === 'PUT';
    const requester = isPut
      ? await this.requireRoles(route, ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'])
      : await this.requireUser(route);
    if (!requester) return;
    const asset = this.assetsById.get(assetId);
    if (!asset) {
      await this.fulfillProblem(route, 404, 'Asset not found', '/errors/not-found');
      return;
    }
    if (!this.assetInScope(requester, asset)) {
      await this.fulfillProblem(route, 403, 'Out of scope', '/errors/out-of-scope');
      return;
    }

    if (!isPut) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(this.scheduleRulesOf(assetId).map((r) => this.toApiScheduleRule(r))),
      });
      return;
    }

    // The api's `ZodValidationPipe` runs BEFORE anything else in the
    // handler: an unknown frequency, or a reason under 10 trimmed
    // characters, never reaches the ambiguity check below.
    const parsed = scheduleAdjustRequestSchema.safeParse(route.request().postDataJSON());
    if (!parsed.success) {
      await this.fulfillValidationFailed(route);
      return;
    }
    const body = parsed.data;
    // Mirrors `AssetScheduleService.adjust`'s `matches` query exactly,
    // including that it is scoped to ACTIVE documents only.
    const matches = this.scheduleRulesOf(assetId).filter(
      (r) =>
        r.frequency === body.frequency &&
        (body.assetDocumentId ? r.assetDocumentId === body.assetDocumentId : true),
    );
    if (matches.length === 0) {
      await this.fulfillProblem(
        route,
        404,
        'Not found',
        '/errors/not-found',
        `ScheduleRule ${assetId}/${body.assetDocumentId ? `${body.assetDocumentId}/` : ''}${body.frequency} was not found.`,
      );
      return;
    }
    if (matches.length > 1) {
      // Same detail text as `AssetScheduleService.adjust`'s
      // `validationFailedProblem` — the refusal the real API gives when a
      // machine carries several documents at the same frequency and the
      // caller did not name which one.
      await this.fulfillProblem(
        route,
        422,
        'Validation failed',
        '/errors/validation-failed',
        `This machine carries ${matches.length} documents scheduled at ${body.frequency}. ` +
          'Name the one to adjust with `assetDocumentId` — adjusting the wrong document’s ' +
          'schedule would silently stop its PM coming due.',
      );
      return;
    }
    const rule = matches[0];
    rule.nextDueOn = body.nextDueOn;
    rule.adjustedReason = body.adjustedReason;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiScheduleRule(rule)),
    });
  }

  /**
   * `GET /schedule` — `planner-schedule.controller.ts`, slice 31-PLANNER.
   * The CROSS-MACHINE read behind `/planner`.
   *
   * Mirrored faithfully, including the three things a spec could otherwise
   * pass against a fake that is kinder than production:
   *
   *  - NO role gate (same as `GET /assets/{id}/schedule`) — but AREA SCOPE
   *    applies, and an out-of-scope machine is simply ABSENT rather than a
   *    403. That difference is the real service's, not a simplification: this
   *    is a collection read, so refusing the whole grid over one invisible
   *    machine would make it useless to the scoped planners it is for.
   *  - A `{data, page}` ENVELOPE, unlike the per-asset read's bare array.
   *  - `plannedDates` PROJECTED across the window and `cascadeFrequencies`
   *    resolved from the document's own rules, both exactly as
   *    `planner-schedule.service.ts` computes them — the grid is drawn from
   *    these, so a fake that returned only `nextDueOn` would let a broken
   *    projection pass CI.
   */
  private async handlePlannerSchedule(route: Route): Promise<void> {
    const requester = await this.requireUser(route);
    if (!requester) return;

    const url = new URL(route.request().url());
    const year = new Date().getUTCFullYear();
    const from = url.searchParams.get('from') ?? `${year}-01-01`;
    const to = url.searchParams.get('to') ?? `${year}-12-31`;
    const assetTypeId = url.searchParams.get('assetTypeId') ?? undefined;
    const areaId = url.searchParams.get('areaId') ?? undefined;

    if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
      await this.fulfillValidationFailed(route);
      return;
    }

    const rows = Array.from(this.assetsById.values())
      .filter((asset) => this.assetInScope(requester, asset))
      .filter((asset) => (assetTypeId ? asset.assetTypeId === assetTypeId : true))
      // Intersected with, never widening, the caller's own scope.
      .filter((asset) => (areaId ? asset.areaId === areaId : true))
      .flatMap((asset) =>
        this.scheduleRulesOf(asset.id)
          .filter((rule) => rule.nextDueOn <= to)
          .map((rule) => this.toApiPlannerRow(asset, rule, from, to)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(rows)),
    });
  }

  private toApiPlannerRow(asset: FakeAsset, rule: FakeScheduleRule, from: string, to: string) {
    const doc = this.assetDocumentsById.get(rule.assetDocumentId);
    const template = doc ? this.templatesById.get(doc.formTemplateId) : undefined;
    // Every ACTIVE rule on the SAME document — what the real service reads
    // through its nested `scheduleRules` include, and what U-CAS-05 makes the
    // cascade depend on (only frequencies the document really has).
    const siblings = Array.from(this.scheduleRulesById.values()).filter(
      (sibling) => sibling.assetDocumentId === rule.assetDocumentId && sibling.active,
    );
    return {
      id: rule.id,
      assetId: asset.id,
      assetCode: asset.code,
      assetDescription: asset.description ?? null,
      areaId: asset.areaId ?? null,
      assetDocumentId: rule.assetDocumentId,
      documentNumber: template?.documentNumber ?? 'UNKNOWN',
      documentTitle: resolveTemplateTitle(template?.title ?? '', doc?.machineNumber ?? null),
      frequency: rule.frequency,
      intervalMonths: rule.intervalMonths,
      nextDueOn: rule.nextDueOn,
      lastCompletedOn: rule.lastCompletedOn,
      adjustedReason: rule.adjustedReason,
      active: rule.active,
      plannedDates: projectVisitDates(rule.nextDueOn, rule.intervalMonths, from, to),
      cascadeFrequencies: siblings
        .filter((sibling) => rule.intervalMonths % sibling.intervalMonths === 0)
        .map((sibling) => sibling.frequency)
        .sort((a, b) => FREQUENCY_INTERVAL_MONTHS[a] - FREQUENCY_INTERVAL_MONTHS[b]),
      // Slice 32-PLANNERJOB. The STORED next-due date only — a projected date
      // has never had anything written against it, exactly as
      // `planner-schedule.service.ts` resolves it. A fake that answered for
      // every `plannedDate` would let the screen invent work.
      nextDueJob: this.toPlannerVisitJob(rule),
      // WHO NORMALLY DOES THIS PM, with the eligibility the server recomputes
      // on every read — a default set while someone was eligible can lapse.
      defaultAssignee: this.toPlannerDefaultAssignee(rule, asset),
      // `nextDueOn` less the MACHINE TYPE's lead time, as
      // `jobGenerationOpensOn()` computes it server-side. Read off the asset
      // type rather than hard-coded to 30, so a spec can prove the screen
      // prints the server's date rather than one of its own.
      jobGenerationOpensOn: addDaysIso(
        rule.nextDueOn,
        -(this.assetTypesById.get(asset.assetTypeId)?.leadTimeDays ?? 30),
      ),
    };
  }

  /**
   * Slice 32-PLANNERJOB — the job for the STORED next-due date, with its
   * assignee. `assignedToName` is decrypted server-side in the real system;
   * here it is simply looked up, but the SHAPE is the same, including
   * `assignedToName === null` exactly when `assignedTo` is.
   */
  private toPlannerVisitJob(rule: FakeScheduleRule) {
    const job = this.generatedJobsByVisit.get(
      visitJobKey(rule.assetDocumentId, rule.frequency, rule.nextDueOn),
    );
    if (!job) return null;
    const assignedTo = this.jobAssignees.get(job.id) ?? null;
    return {
      ...job,
      assignedTo,
      assignedToName: assignedTo ? (this.adminUsers.get(assignedTo)?.fullName ?? null) : null,
    };
  }

  /**
   * WHO NORMALLY DOES THIS PM, and whether they would STILL be accepted.
   *
   * `eligibility` is recomputed on every read rather than stored, exactly as
   * `assignable-user.service.ts#resolveEligibility` does — the whole hazard
   * this field exists for is a default that was valid when it was set and is
   * not any more, so a fake that cached it could never reproduce it.
   */
  private toPlannerDefaultAssignee(rule: FakeScheduleRule, asset: FakeAsset) {
    const userId = this.ruleDefaultAssignee.get(rule.id) ?? null;
    if (!userId) return null;
    const user = this.adminUsers.get(userId);
    return {
      id: userId,
      fullName: user?.fullName ?? 'Unknown user',
      // `'unknown'` mirrors the real service's missing-row branch: a fact
      // about the DATABASE, never reported as ineligibility of a named person.
      eligibility: user
        ? this.isAssignableTo(user, asset.areaId ?? null)
          ? 'assignable'
          : 'not-assignable'
        : 'unknown',
    };
  }

  /**
   * THE ONE ASSIGNABILITY RULE, mirroring `assignable-user.service.ts`: an
   * ACTIVE user, holding a result-recording role, whose area scope reaches the
   * machine (no scopes at all = unrestricted; a machine with no area is
   * reachable only by an unrestricted user).
   *
   * Mirrored rather than simplified on purpose — the picker's whole promise is
   * that it never offers somebody the server would refuse, and a fake that was
   * more permissive would let a broken picker pass CI.
   */
  private isAssignableTo(user: FakeAdminUser, areaId: string | null): boolean {
    if (!user.active) return false;
    if (!user.roles.some((role) => JOB_RECORD_ROLES.includes(role))) return false;
    if (user.areaIds.length === 0) return true;
    return areaId !== null && user.areaIds.includes(areaId);
  }

  /**
   * `GET /schedule/{scheduleRuleId}/assignable-users` — slice 32-PLANNERJOB.
   *
   * Mirrors the real endpoint's three refusals rather than simplifying them,
   * because the SCREEN's guarantee is that it never offers somebody the server
   * will reject: a role gate (the four that may assign), 404 for an unknown
   * rule, and 403 `out-of-scope` for a machine the caller cannot see — NOT the
   * "simply absent" behaviour of the collection read, because a named rule
   * that exists must not be answered with a lie.
   */
  private async handleAssignableUsers(route: Route, scheduleRuleId: string): Promise<void> {
    const requester = await this.requireRoles(route, ASSIGN_ROLES);
    if (!requester) return;

    const rule = this.scheduleRulesById.get(scheduleRuleId);
    const asset = rule ? this.assetOfRule(rule) : undefined;
    if (!rule || !asset) {
      await this.fulfillProblem(route, 404, 'Not found', '/errors/not-found');
      return;
    }
    if (!this.assetInScope(requester, asset)) {
      await this.fulfillProblem(route, 403, 'Out of scope', '/errors/out-of-scope');
      return;
    }

    const data = Array.from(this.adminUsers.values())
      .filter((user) => this.isAssignableTo(user, asset.areaId ?? null))
      .map((user) => ({
        id: user.id,
        fullName: user.fullName,
        // Only the roles that put them on the list — never the full role set.
        roles: user.roles.filter((role) => JOB_RECORD_ROLES.includes(role)).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(data)),
    });
  }

  /**
   * `PUT /schedule/{scheduleRuleId}/default-assignee` — slice 32-PLANNERJOB.
   * Sets WHO NORMALLY DOES THIS PM, and touches no job.
   *
   * The 422 is mirrored deliberately: it is what a picker built on a
   * client-side guess would collect, so a spec can prove the screen never
   * provokes it.
   */
  private async handleSetDefaultAssignee(route: Route, scheduleRuleId: string): Promise<void> {
    const requester = await this.requireRoles(route, ASSIGN_ROLES);
    if (!requester) return;

    const rule = this.scheduleRulesById.get(scheduleRuleId);
    const asset = rule ? this.assetOfRule(rule) : undefined;
    if (!rule || !asset) {
      await this.fulfillProblem(route, 404, 'Not found', '/errors/not-found');
      return;
    }
    if (!this.assetInScope(requester, asset)) {
      await this.fulfillProblem(route, 403, 'Out of scope', '/errors/out-of-scope');
      return;
    }

    const body = route.request().postDataJSON() as { defaultAssigneeId?: string | null };
    const assigneeId = body.defaultAssigneeId ?? null;
    if (assigneeId) {
      const user = this.adminUsers.get(assigneeId);
      if (!user || !this.isAssignableTo(user, asset.areaId ?? null)) {
        await this.fulfillProblem(
          route,
          422,
          'Validation failed',
          '/errors/validation-failed',
          'That person cannot be assigned to this machine.',
        );
        return;
      }
    }

    // ONE COLUMN. `jobAssignees` is deliberately untouched: changing the plan
    // must not move work already raised, and a fake that did would make the
    // spec proving it impossible to write.
    this.ruleDefaultAssignee.set(scheduleRuleId, assigneeId);

    const user = assigneeId ? this.adminUsers.get(assigneeId) : undefined;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scheduleRuleId,
        defaultAssignee: user
          ? {
              id: user.id,
              fullName: user.fullName,
              eligibility: this.isAssignableTo(user, asset.areaId ?? null)
                ? 'assignable'
                : 'not-assignable',
            }
          : null,
      }),
    });
  }

  /**
   * `POST /jobs/{jobId}/assign` — slice 15-SYSWIRE, first called by this app
   * in slice 32-PLANNERJOB. Assigns or reassigns ONE occurrence.
   *
   * Mirrors the state machine (`job-state-machine.ts`): ASSIGN is legal from
   * SCHEDULED/ASSIGNED/IN_PROGRESS and 409 otherwise, and the first assignment
   * moves SCHEDULED -> ASSIGNED. The screen hides the control for the illegal
   * states, so the 409 exists here precisely so a spec can prove it does.
   */
  private async handleAssignJob(route: Route, jobId: string): Promise<void> {
    const requester = await this.requireRoles(route, ASSIGN_ROLES);
    if (!requester) return;

    const job = this.jobs.get(jobId);
    if (!job) {
      await this.fulfillProblem(route, 404, 'Not found', '/errors/not-found');
      return;
    }
    const status = this.jobStatus.get(jobId) ?? job.status ?? 'SCHEDULED';
    if (!['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'].includes(status)) {
      await this.fulfillProblem(
        route,
        409,
        'Invalid transition',
        '/errors/invalid-transition',
        `A ${status} job cannot be reassigned.`,
      );
      return;
    }

    const body = route.request().postDataJSON() as { assigneeId?: string };
    const assignee = body.assigneeId ? this.adminUsers.get(body.assigneeId) : undefined;
    if (!assignee) {
      await this.fulfillProblem(route, 422, 'Validation failed', '/errors/validation-failed');
      return;
    }

    // ONE COLUMN, again. `ruleDefaultAssignee` is untouched: covering a single
    // visit must not rewrite who normally does the machine's maintenance.
    this.jobAssignees.set(jobId, assignee.id);
    const generated = Array.from(this.generatedJobsByVisit.values()).find((g) => g.id === jobId);
    if (status === 'SCHEDULED') {
      this.jobStatus.set(jobId, 'ASSIGNED');
      if (generated) generated.status = 'ASSIGNED';
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiJob(job)),
    });
  }

  /** The machine a rule hangs off, through its document. */
  private assetOfRule(rule: FakeScheduleRule): FakeAsset | undefined {
    const doc = this.assetDocumentsById.get(rule.assetDocumentId);
    return doc ? this.assetsById.get(doc.assetId) : undefined;
  }

  private assetInScope(requester: FakeAdminUser, asset: FakeAsset): boolean {
    if (requester.areaIds.length === 0) return true;
    return asset.areaId != null && requester.areaIds.includes(asset.areaId);
  }

  private async handleAssets(route: Route): Promise<void> {
    if (route.request().method() === 'POST') {
      const requester = await this.requireRoles(route, ['ENGINEER', 'ADMIN']);
      if (!requester) return;
      const body = route.request().postDataJSON() as {
        code?: string;
        assetTypeId?: string;
        description?: string;
        manufacturer?: string;
        model?: string;
        serialNumber?: string;
        areaId?: string;
        locationDetail?: string;
        commissionedOn?: string;
        scheduleAnchorDate?: string;
      };
      if (
        !body.assetTypeId ||
        !this.assetTypesById.has(body.assetTypeId) ||
        !body.scheduleAnchorDate
      ) {
        await this.fulfillProblem(route, 422, 'Validation failed', '/errors/validation-failed');
        return;
      }
      if (body.code && Array.from(this.assetsById.values()).some((a) => a.code === body.code)) {
        await this.fulfillProblem(
          route,
          409,
          'Conflict',
          '/errors/conflict',
          `Asset code '${body.code}' is already in use.`,
        );
        return;
      }
      // Same shape production's `generateProvisionalAssetCode` emits
      // (`PROV-` + 8 uppercase hex chars) — deliberately unmistakable for a
      // real plant code.
      const code =
        body.code ?? `PROV-${(++this.provisionalSeq).toString(16).toUpperCase().padStart(8, '0')}`;
      const asset: FakeAsset = {
        id: `asset-${++this.assetSeq}`,
        code,
        codeProvisional: !body.code,
        assetTypeId: body.assetTypeId,
        description: body.description ?? null,
        manufacturer: body.manufacturer ?? null,
        model: body.model ?? null,
        serialNumber: body.serialNumber ?? null,
        areaId: body.areaId ?? null,
        locationDetail: body.locationDetail ?? null,
        commissionedOn: body.commissionedOn ?? null,
        scheduleAnchorDate: body.scheduleAnchorDate,
        status: 'ACTIVE',
        active: true,
      };
      this.assetsById.set(asset.id, asset);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(this.toApiAsset(asset)),
      });
      return;
    }
    const requester = await this.requireUser(route);
    if (!requester) return;
    const url = new URL(route.request().url());
    const assetTypeId = url.searchParams.get('assetTypeId');
    const assets = Array.from(this.assetsById.values())
      .filter((a) => (assetTypeId ? a.assetTypeId === assetTypeId : true))
      .filter((a) => this.assetInScope(requester, a));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.page(assets.map((a) => this.toApiAsset(a)))),
    });
  }

  private async handleAssetById(route: Route, assetId: string): Promise<void> {
    const method = route.request().method();
    const requester =
      method === 'PATCH'
        ? await this.requireRoles(route, ['ENGINEER', 'ADMIN'])
        : await this.requireUser(route);
    if (!requester) return;
    const asset = this.assetsById.get(assetId);
    if (!asset) {
      await this.fulfillProblem(route, 404, 'Asset not found', '/errors/not-found');
      return;
    }
    if (!this.assetInScope(requester, asset)) {
      // PR-API-10 by-id reads: exists but out of scope is an explicit 403.
      await this.fulfillProblem(route, 403, 'Out of scope', '/errors/out-of-scope');
      return;
    }
    if (method === 'PATCH') {
      const body = route.request().postDataJSON() as {
        code?: string;
        description?: string;
        manufacturer?: string;
        model?: string;
        /** Review B-1: nullable — explicit null clears, omission keeps. */
        areaId?: string | null;
        locationDetail?: string;
        status?: 'ACTIVE' | 'UNDER_REPAIR' | 'DECOMMISSIONED';
        active?: boolean;
      };
      if (body.code !== undefined && body.code !== asset.code) {
        const duplicate = Array.from(this.assetsById.values()).some(
          (a) => a.id !== asset.id && a.code === body.code,
        );
        if (duplicate) {
          await this.fulfillProblem(
            route,
            409,
            'Conflict',
            '/errors/conflict',
            `Asset code '${body.code}' is already in use.`,
          );
          return;
        }
        asset.code = body.code;
        // The confirmation semantics the machines journey proves: only an
        // actual CHANGE clears the flag (a same-code PATCH does not).
        asset.codeProvisional = false;
      }
      if (body.description !== undefined) asset.description = body.description;
      if (body.manufacturer !== undefined) asset.manufacturer = body.manufacturer;
      if (body.model !== undefined) asset.model = body.model;
      if (body.areaId !== undefined) asset.areaId = body.areaId;
      if (body.locationDetail !== undefined) asset.locationDetail = body.locationDetail;
      if (body.status !== undefined) asset.status = body.status;
      if (body.active !== undefined) asset.active = body.active;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(this.toApiAsset(asset)),
    });
  }

  async install(page: Page): Promise<void> {
    // ---- Auth: exempt from the forced-password-change guard by design.
    await page.route('**/api/v1/auth/login', (route) => this.handleLogin(route));
    await page.route('**/api/v1/auth/refresh', (route) => this.handleRefresh(route));
    await page.route('**/api/v1/auth/logout', (route) => this.handleLogout(route));
    await page.route('**/api/v1/auth/password', (route) => this.handlePasswordChange(route));
    await page.route('**/api/v1/auth/mfa/verify', (route) => this.handleMfaVerify(route));
    await page.route('**/api/v1/auth/mfa/recovery', (route) => this.handleMfaRecovery(route));
    await page.route('**/api/v1/auth/mfa/enrol/confirm', (route) =>
      this.handleMfaEnrolConfirm(route),
    );
    await page.route('**/api/v1/auth/mfa/enrol', (route) => this.handleMfaEnrol(route));

    // ---- Everything else runs behind the global forced-change guard.
    await page.route(
      '**/api/v1/auth/step-up',
      this.guarded((route) => this.handleStepUp(route)),
    );
    await page.route(
      /\/api\/v1\/users\/([^/]+)\/mfa-reset/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/users\/([^/]+)\/mfa-reset/);
        return this.handleMfaReset(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );
    await page.route(
      '**/api/v1/sync/bootstrap*',
      this.guarded((route) => this.handleBootstrap(route)),
    );
    await page.route(
      '**/api/v1/sync/outbox',
      this.guarded((route) => this.handleOutbox(route)),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/submit/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/submit/);
        return this.handleSubmit(route, match ? match[1] : 'unknown');
      }),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/attachments$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/attachments$/);
        return this.handleUploadAttachment(route, match ? match[1] : 'unknown');
      }),
    );
    await page.route(
      '**/api/v1/queue*',
      this.guarded((route) => this.handleQueue(route)),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/verify/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/verify/);
        return this.handleVerify(route, match ? match[1] : 'unknown');
      }),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/return/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/return/);
        return this.handleReturn(route, match ? match[1] : 'unknown');
      }),
    );
    // Anchored (no trailing segment) so it never intercepts /submit,
    // /verify, /return, /items/*, /measurements/*, /parts, /attachments —
    // all of which are registered as their own, more specific routes above
    // and below. Playwright resolves overlapping routes last-registered-
    // first, but this still keeps each handler's own responsibility
    // unambiguous to read.
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)$/);
        return this.handleGetJob(route, match ? match[1] : 'unknown');
      }),
    );
    // Slice 18-WORKFLOW §2 — registered AFTER the generic `/jobs/{id}` route
    // ABOVE, deliberately: Playwright resolves overlapping routes
    // last-registered-first, and `/jobs/adhoc` matches `/jobs/([^/]+)$` too.
    // Registering it earlier makes the by-id handler win and answer
    // "Job not found" for every ad-hoc creation.
    await page.route(
      /\/api\/v1\/jobs\/adhoc$/,
      this.guarded((route) => this.handleCreateAdhocJob(route)),
    );
    // ---- Slice 13-UI-B: the admin surface. Anchored regexes so the
    // more-specific /users/{id}/mfa-reset and /users/{id}/area-scopes
    // handlers never collide with the by-id route.
    await page.route(
      /\/api\/v1\/users(\?.*)?$/,
      this.guarded((route) => {
        if (route.request().method() === 'POST') return this.handleCreateUser(route);
        return this.handleListUsers(route);
      }),
    );
    await page.route(
      /\/api\/v1\/users\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/users\/([^/]+)$/);
        const userId = match ? decodeURIComponent(match[1]) : 'unknown';
        if (route.request().method() === 'PATCH') return this.handlePatchUser(route, userId);
        return this.handleGetUser(route, userId);
      }),
    );
    await page.route(
      /\/api\/v1\/users\/([^/]+)\/area-scopes$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/users\/([^/]+)\/area-scopes$/);
        return this.handleSetUserAreaScopes(
          route,
          match ? decodeURIComponent(match[1]) : 'unknown',
        );
      }),
    );
    await page.route(
      /\/api\/v1\/roles(\?.*)?$/,
      this.guarded((route) => this.handleListRoles(route)),
    );
    await page.route(
      /\/api\/v1\/areas(\?.*)?$/,
      this.guarded((route) => this.handleAreas(route)),
    );
    await page.route(
      /\/api\/v1\/areas\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/areas\/([^/]+)$/);
        return this.handlePatchArea(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );
    await page.route(
      /\/api\/v1\/asset-types(\?.*)?$/,
      this.guarded((route) => this.handleListAssetTypes(route)),
    );
    await page.route(
      /\/api\/v1\/assets(\?.*)?$/,
      this.guarded((route) => this.handleAssets(route)),
    );
    await page.route(
      /\/api\/v1\/assets\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/assets\/([^/]+)$/);
        return this.handleAssetById(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );
    // ---- Slice 28-ASSETDOC-UI. `/assets/{id}/documents` cannot collide with
    // the anchored by-id route above (that one ends at the id), but it is
    // registered afterwards anyway so the more specific path wins outright
    // under Playwright's last-registered-first resolution.
    await page.route(
      /\/api\/v1\/templates(\?.*)?$/,
      this.guarded((route) => this.handleListTemplates(route)),
    );
    await page.route(
      /\/api\/v1\/assets\/([^/]+)\/documents$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/assets\/([^/]+)\/documents$/);
        return this.handleAssetDocuments(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );
    await page.route(
      /\/api\/v1\/asset-documents\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/asset-documents\/([^/]+)$/);
        return this.handlePatchAssetDocument(
          route,
          match ? decodeURIComponent(match[1]) : 'unknown',
        );
      }),
    );
    // Slice 29-SCHEDULE-UI — same reasoning as `/assets/{id}/documents`
    // above: `/assets/{id}/schedule` cannot collide with the anchored by-id
    // route (that one ends at the id), registered after it regardless so the
    // more specific path wins outright under Playwright's
    // last-registered-first resolution.
    await page.route(
      /\/api\/v1\/assets\/([^/]+)\/schedule$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/assets\/([^/]+)\/schedule$/);
        return this.handleAssetSchedule(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );

    // Slice 31-PLANNER — the cross-machine read behind `/planner`. A
    // top-level path, so it cannot collide with `/assets/{id}/schedule`
    // registered above; the trailing `(\?.*)?` admits the window and filter
    // query the screen always sends.
    await page.route(
      /\/api\/v1\/schedule(\?.*)?$/,
      this.guarded((route) => this.handlePlannerSchedule(route)),
    );
    // Slice 32-PLANNERJOB — the two assignment routes on the schedule
    // surface. Registered AFTER the collection read above so the more
    // specific paths win under Playwright's last-registered-first resolution
    // (they could not collide regardless: that pattern ends at `/schedule`).
    await page.route(
      /\/api\/v1\/schedule\/([^/]+)\/assignable-users(\?.*)?$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/schedule\/([^/]+)\/assignable-users/);
        return this.handleAssignableUsers(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );
    await page.route(
      /\/api\/v1\/schedule\/([^/]+)\/default-assignee$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/schedule\/([^/]+)\/default-assignee$/);
        return this.handleSetDefaultAssignee(
          route,
          match ? decodeURIComponent(match[1]) : 'unknown',
        );
      }),
    );
    await page.route(
      /\/api\/v1\/jobs\/([^/]+)\/assign$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/jobs\/([^/]+)\/assign$/);
        return this.handleAssignJob(route, match ? decodeURIComponent(match[1]) : 'unknown');
      }),
    );

    await page.route(
      '**/api/v1/delegations',
      this.guarded((route) => {
        if (route.request().method() === 'POST') return this.handleCreateDelegation(route);
        return this.handleListDelegations(route);
      }),
    );
    await page.route(
      /\/api\/v1\/delegations\/([^/]+)$/,
      this.guarded((route) => {
        const match = route
          .request()
          .url()
          .match(/\/delegations\/([^/]+)$/);
        return this.handleRevokeDelegation(route, match ? match[1] : 'unknown');
      }),
    );
  }
}
