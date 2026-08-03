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
