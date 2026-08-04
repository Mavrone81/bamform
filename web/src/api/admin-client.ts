import { authorizedFetch } from './http-transport';
import type { components } from './generated/openapi-types';

/**
 * Slice 13-UI-B — the admin surface's API client (`/users`, `/roles`,
 * `/areas`, `/asset-types`, `/assets`, `/users/{id}/area-scopes`).
 *
 * Deliberately OUTSIDE `SyncTransport`: nothing here is offline-queueable —
 * administration is an online, at-a-desk activity, and a queued "deactivate
 * user" or "replace area scopes" replayed hours later against a changed
 * system would be actively dangerous. Every call goes through
 * `authorizedFetch` (bearer + silent 401-refresh + the forced-password-change
 * latch) and reports its outcome to the caller instead of throwing, because
 * these endpoints have specific, screen-visible non-2xx outcomes the admin
 * must see honestly: the last-admin 409 (SYS-11), duplicate-email 409,
 * duplicate-asset-code 409, unknown-areaId 422, and plain 403 for a
 * non-admin who reached the URL (non-negotiable #6: the server decides).
 *
 * `status: 0` = no response at all (offline/DNS/TLS) — kept distinguishable
 * from every real refusal, mirroring `AuthCallResult`.
 */

export type Problem = components['schemas']['Problem'];
export type AdminUser = components['schemas']['User'];
export type AdminUserCreate = components['schemas']['UserCreate'];
export type AdminUserUpdate = components['schemas']['UserUpdate'];
export type Role = components['schemas']['Role'];
export type RoleCode = components['schemas']['RoleCode'];
export type Area = components['schemas']['Area'];
export type AreaCreate = components['schemas']['AreaCreate'];
export type AreaUpdate = components['schemas']['AreaUpdate'];
export type AssetType = components['schemas']['AssetType'];
export type Asset = components['schemas']['Asset'];
export type AssetCreate = components['schemas']['AssetCreate'];
export type AssetUpdate = components['schemas']['AssetUpdate'];
export type FormTemplate = components['schemas']['FormTemplate'];
export type AssetDocument = components['schemas']['AssetDocument'];
export type AssetDocumentCreate = components['schemas']['AssetDocumentCreate'];
export type AssetDocumentUpdate = components['schemas']['AssetDocumentUpdate'];
export type ScheduleRule = components['schemas']['ScheduleRule'];
export type ScheduleAdjust = components['schemas']['ScheduleAdjust'];
export type PlannerScheduleRow = components['schemas']['PlannerScheduleRow'];
export type PlannerVisitJob = components['schemas']['PlannerVisitJob'];
export type PlannerDefaultAssignee = components['schemas']['PlannerDefaultAssignee'];
export type AssignableUser = components['schemas']['AssignableUser'];
export type Job = components['schemas']['Job'];

export interface AdminPage<T> {
  data: T[];
  page: { nextCursor?: string | null; hasMore: boolean; limit: number };
}

export type AdminResult<T> =
  { ok: true; status: number; value: T } | { ok: false; status: number; problem?: Problem };

/** The server clamps `limit` to 100 (PR-API-14) — ask for the maximum and
 * let the screens offer "Load more" via the cursor when `hasMore`. */
const PAGE_LIMIT = 100;

async function call<T>(path: string, init: RequestInit = {}): Promise<AdminResult<T>> {
  let res: Response;
  try {
    res = await authorizedFetch(path, init);
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as Problem | undefined;
    return { ok: false, status: res.status, problem };
  }
  const value = (await res.json().catch(() => undefined)) as T;
  return { ok: true, status: res.status, value };
}

const jsonHeaders = { 'Content-Type': 'application/json' } as const;

function pageQuery(cursor?: string): string {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) query.set('cursor', cursor);
  return `?${query.toString()}`;
}

// ---------------------------------------------------------------- users

export function listUsers(params?: {
  cursor?: string;
}): Promise<AdminResult<AdminPage<AdminUser>>> {
  return call(`/users${pageQuery(params?.cursor)}`);
}

export function getUser(userId: string): Promise<AdminResult<AdminUser>> {
  return call(`/users/${encodeURIComponent(userId)}`);
}

export function createUser(body: AdminUserCreate): Promise<AdminResult<AdminUser>> {
  return call('/users', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
}

export function updateUser(userId: string, body: AdminUserUpdate): Promise<AdminResult<AdminUser>> {
  return call(`/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

/** `PUT /users/{userId}/area-scopes` — REPLACES the set; `[]` clears every
 * scope (the user becomes unrestricted). See api/openapi.yaml. */
export function setUserAreaScopes(
  userId: string,
  areaIds: string[],
): Promise<AdminResult<AdminUser>> {
  return call(`/users/${encodeURIComponent(userId)}/area-scopes`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ areaIds }),
  });
}

// ---------------------------------------------------------------- catalogues

export function listRoles(): Promise<AdminResult<AdminPage<Role>>> {
  return call(`/roles${pageQuery()}`);
}

export function listAreas(params?: { cursor?: string }): Promise<AdminResult<AdminPage<Area>>> {
  return call(`/areas${pageQuery(params?.cursor)}`);
}

export function createArea(body: AreaCreate): Promise<AdminResult<Area>> {
  return call('/areas', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
}

export function updateArea(areaId: string, body: AreaUpdate): Promise<AdminResult<Area>> {
  return call(`/areas/${encodeURIComponent(areaId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

export function listAssetTypes(): Promise<AdminResult<AdminPage<AssetType>>> {
  return call(`/asset-types${pageQuery()}`);
}

/** The controlled-document catalogue (`GET /templates`) — what an admin picks
 * FROM when tagging a document to a machine. Read-only: the twelve source
 * templates are loaded by BAMFORM-TLP-001's tooling, not through a screen. */
export function listTemplates(params?: {
  cursor?: string;
}): Promise<AdminResult<AdminPage<FormTemplate>>> {
  return call(`/templates${pageQuery(params?.cursor)}`);
}

// ---------------------------------------------------------------- machines

export function listAssets(params?: {
  assetTypeId?: string;
  cursor?: string;
}): Promise<AdminResult<AdminPage<Asset>>> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (params?.assetTypeId) query.set('assetTypeId', params.assetTypeId);
  if (params?.cursor) query.set('cursor', params.cursor);
  return call(`/assets?${query.toString()}`);
}

export function getAsset(assetId: string): Promise<AdminResult<Asset>> {
  return call(`/assets/${encodeURIComponent(assetId)}`);
}

/** `code` omitted = the server generates a provisional/"RED" code (B-09). */
export function createAsset(body: AssetCreate): Promise<AdminResult<Asset>> {
  return call('/assets', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
}

/** Changing `code` is what CONFIRMS a provisional one (clears the flag). */
export function updateAsset(assetId: string, body: AssetUpdate): Promise<AdminResult<Asset>> {
  return call(`/assets/${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------- machine documents (27/28)

/**
 * Slice 28-ASSETDOC-UI — the PM documents a machine carries.
 *
 * `GET /assets/{assetId}/documents` deliberately carries NO `@Roles()`
 * server-side: it is the MAINTAINER's form picker (owner's process step 4) as
 * much as the admin's tagging list, so this one function lives in the admin
 * client but is called from "Raise a job" too. Area scope still applies, and
 * an out-of-scope machine answers 403, never a silent empty list.
 *
 * NOT paginated — a small, fixed-cardinality set scoped to ONE machine, so the
 * response is a bare `{ data }` with no `page` envelope and no `limit` query.
 * DEACTIVATED documents are included; a machine's history stays visible.
 */
export function listAssetDocuments(
  assetId: string,
): Promise<AdminResult<{ data: AssetDocument[] }>> {
  return call(`/assets/${encodeURIComponent(assetId)}/documents`);
}

/** `POST /assets/{assetId}/documents` — ENGINEER or ADMIN. 409 if the machine
 * already carries that document. */
export function tagAssetDocument(
  assetId: string,
  body: AssetDocumentCreate,
): Promise<AdminResult<AssetDocument>> {
  return call(`/assets/${encodeURIComponent(assetId)}/documents`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

/** `PATCH /asset-documents/{id}` — ENGINEER or ADMIN. There is no DELETE
 * anywhere in this API (INV-16): retiring a document is `active: false`, which
 * leaves every job it already generated resolvable. */
export function updateAssetDocument(
  id: string,
  body: AssetDocumentUpdate,
): Promise<AdminResult<AssetDocument>> {
  return call(`/asset-documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

// -------------------------------------------------- machine schedule (29)

/**
 * `GET /assets/{assetId}/schedule` — carries NO `@Roles()` server-side: every
 * authenticated user may read a machine's schedule (area-scoped inside the
 * service), same as `listAssetDocuments`. It ALSO lazily bootstraps
 * `schedule_rule` rows on first read (`ScheduleRuleBootstrapService`) — a GET
 * can itself create rows, and that is intentional self-healing, not a
 * side-effect to route around.
 *
 * Bare array response, no `{ data }`/`page` envelope: a small,
 * fixed-cardinality set (one row per scheduled frequency per document) scoped
 * to ONE machine, exactly like `listAssetDocuments`.
 */
export function getAssetSchedule(assetId: string): Promise<AdminResult<ScheduleRule[]>> {
  return call(`/assets/${encodeURIComponent(assetId)}/schedule`);
}

/**
 * `PUT /assets/{assetId}/schedule` — PLANNER, TEAM_LEADER, ENGINEER or ADMIN.
 * Adjusts exactly ONE frequency per call and requires `adjustedReason` (min
 * 10 characters); it is recorded to the audit trail. `assetDocumentId` is
 * optional only when the machine carries a single document at that
 * frequency — callers here always send it (slice 27: a machine can carry
 * several documents scheduled at the same frequency, and naming the wrong
 * one would silently move a different document's due date).
 */
export function adjustAssetSchedule(
  assetId: string,
  body: ScheduleAdjust,
): Promise<AdminResult<ScheduleRule>> {
  return call(`/assets/${encodeURIComponent(assetId)}/schedule`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------- the planner grid (31)

/**
 * `GET /schedule` — the CROSS-MACHINE schedule read behind `/planner`, the
 * screen that replaces `ML-S-MFT-00015`.
 *
 * Carries NO `@Roles()` server-side, exactly like `getAssetSchedule` above:
 * every authenticated user may read a schedule. The Menu offers `/planner`
 * only to the roles that plan, which is presentation, not enforcement
 * (non-negotiable #6) — and the WRITE the screen leads to is still
 * `adjustAssetSchedule`, which is genuinely role-gated.
 *
 * PAGINATED, unlike `getAssetSchedule`'s bare array: that one is
 * fixed-cardinality for a single machine, this is a tenant-wide collection
 * and follows the standard cursor envelope. 76 machines at ~3 rules each
 * exceeds the server's 100-row clamp, so `listAllPlannerSchedule` below
 * follows the cursor rather than silently drawing three quarters of a plan.
 */
export function listPlannerSchedule(params: {
  from: string;
  to: string;
  assetTypeId?: string;
  areaId?: string;
  cursor?: string;
}): Promise<AdminResult<AdminPage<PlannerScheduleRow>>> {
  const query = new URLSearchParams({
    limit: String(PAGE_LIMIT),
    from: params.from,
    to: params.to,
  });
  if (params.assetTypeId) query.set('assetTypeId', params.assetTypeId);
  if (params.areaId) query.set('areaId', params.areaId);
  if (params.cursor) query.set('cursor', params.cursor);
  return call(`/schedule?${query.toString()}`);
}

/**
 * The whole window, cursor followed to the end. A partial grid is worse than
 * no grid: a planner deciding week 12 is free, when the machines that would
 * have filled it were simply on page two, plans work into a week that is
 * already full. So this either returns every row or reports the refusal.
 *
 * `MAX_PLANNER_PAGES` bounds it at 5000 rows — roughly twenty times the
 * plant's ~230 scheduled rules. It exists so a server-side paging fault
 * cannot spin the browser, not as a business limit; hitting it is reported as
 * a refusal rather than quietly truncating, for the same reason.
 */
const MAX_PLANNER_PAGES = 50;

export async function listAllPlannerSchedule(params: {
  from: string;
  to: string;
  assetTypeId?: string;
  areaId?: string;
}): Promise<AdminResult<PlannerScheduleRow[]>> {
  const rows: PlannerScheduleRow[] = [];
  let cursor: string | undefined;
  let lastStatus = 0;

  for (let page = 0; page < MAX_PLANNER_PAGES; page += 1) {
    const result = await listPlannerSchedule({ ...params, cursor });
    if (!result.ok) return result;
    lastStatus = result.status;
    rows.push(...result.value.data);
    if (!result.value.page.hasMore || !result.value.page.nextCursor) {
      return { ok: true, status: result.status, value: rows };
    }
    cursor = result.value.page.nextCursor;
  }

  // Review M-3: this used to return `status: 0`, which every caller renders
  // as "Could not reach the server" — the one thing that definitely did NOT
  // happen, since fifty consecutive requests just succeeded. The status kept
  // here is the real one from the last page (200); the refusal is the
  // client's own, so it carries its own problem text and says what to do.
  return {
    ok: false,
    status: lastStatus,
    problem: {
      // `about:blank` is RFC 7807's own value for a problem with no
      // registered type, which is exactly what this is: a CLIENT-side
      // refusal, deliberately not borrowed from the server's `/errors/*`
      // catalogue, since the server never refused anything here.
      type: 'about:blank',
      status: lastStatus,
      title: 'The plan is too large to load in one view',
      detail:
        `The maintenance plan was still returning rows after ${MAX_PLANNER_PAGES} pages, so it ` +
        'has not been drawn: a partly-loaded plan would show weeks as free when they are not. ' +
        'Narrow it with the machine-type filter, or look at one year at a time.',
    },
  };
}

// ------------------------------------------- assignment (slice 32-PLANNERJOB)

/**
 * `GET /schedule/{scheduleRuleId}/assignable-users` — WHO this machine's PM
 * may be given to.
 *
 * ONE list for BOTH assignment levels, because the server judges both against
 * the same machine's area: the STANDING assignee on the rule (who normally
 * does this PM) and the assignee on ONE generated job (who does this
 * occurrence). Two client-side lists would eventually disagree about who is
 * eligible, and the planner would have no way to tell which one was right.
 *
 * The list cannot lie: `assignable-user.service.ts` computes it with the same
 * predicate `POST /jobs/{jobId}/assign` enforces, so nobody offered here can
 * come back as a 422. That is why this endpoint exists at all — `GET /users`
 * is ADMIN-only, so a PLANNER had no readable source, and filtering the
 * directory client-side would have been a guess at a three-table rule.
 *
 * ONE PAGE ONLY, at the 100-row clamp. The plant's technician roster is a
 * couple of dozen people; `hasMore` is surfaced to the caller so a site that
 * outgrows one page says so rather than silently offering a truncated list.
 */
export function listAssignableUsers(
  scheduleRuleId: string,
): Promise<AdminResult<AdminPage<AssignableUser>>> {
  return call(`/schedule/${encodeURIComponent(scheduleRuleId)}/assignable-users${pageQuery()}`);
}

/**
 * `PUT /schedule/{scheduleRuleId}/default-assignee` — set (or clear, with
 * `null`) WHO NORMALLY DOES THIS PM.
 *
 * Writes `schedule_rule.default_assignee_id` and touches no job: it changes
 * who FUTURE generated jobs go to, and leaves every job already raised exactly
 * as it is. The screen says so — a control that silently moved work already in
 * progress would be a different and much worse feature.
 */
export function setScheduleDefaultAssignee(
  scheduleRuleId: string,
  defaultAssigneeId: string | null,
): Promise<AdminResult<components['schemas']['SetDefaultAssigneeResult']>> {
  return call(`/schedule/${encodeURIComponent(scheduleRuleId)}/default-assignee`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ defaultAssigneeId }),
  });
}

/**
 * `POST /jobs/{jobId}/assign` — assign or reassign ONE occurrence.
 *
 * Built and tested server-side since slice 15-SYSWIRE and called by NOTHING in
 * this app until now, which is why every generated job has sat unassigned.
 *
 * NO `Idempotency-Key`, deliberately. The header is honoured but not required,
 * and the operation is naturally idempotent in the only way that matters: it
 * SETS `assigned_to` to a named user rather than appending anything, so a
 * retried request lands the same job on the same person. A key would only
 * change behaviour in the case where a planner has since chosen somebody ELSE
 * — and there the replay-cached response would hide that from them, which is
 * worse than simply repeating the write. (Contrast the offline outbox, where
 * a key is essential because the client cannot see the outcome at all.)
 *
 * Writes `job.assigned_to` and never `schedule_rule.default_assignee_id`:
 * covering one visit must not rewrite the plan.
 */
export function assignJob(jobId: string, assigneeId: string): Promise<AdminResult<Job>> {
  return call(`/jobs/${encodeURIComponent(jobId)}/assign`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ assigneeId }),
  });
}
