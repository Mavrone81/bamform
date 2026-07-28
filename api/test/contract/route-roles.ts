/**
 * THE COMPLETE `@Roles()` INVENTORY — every route in the system, with the
 * exact role set that may reach it.
 *
 * WHY THIS FILE EXISTS. Slice 18-WORKFLOW's review found finding X-1
 * (Critical): adding `PLANNER` to `JOB_VIEW_ALL_ROLES` — a constant whose
 * documented job was "can this caller see THIS row" — silently granted a
 * planning role `POST /records/export`, `GET /exports/{id}`, its download and
 * all four `/reports/*` endpoints, because those controllers annotated
 * themselves `@Roles(...JOB_VIEW_ALL_ROLES)`. The export path renders PDFs
 * with DECRYPTED signatory names and drawn-signature images. Nothing in CI
 * noticed: the slice's own additivity test hard-coded three route keys and
 * only checked that nothing was REMOVED.
 *
 * A role appearing on an unrelated surface is exactly as dangerous as a role
 * disappearing from an intended one, and a shared array makes the first
 * invisible in a diff. So this is an EXACT, both-directions inventory, not a
 * spot check: `route-roles.spec.ts` asserts that every route's real
 * `@Roles()` metadata equals its entry here, that every entry names a real
 * route, and that a route absent from `PUBLIC_OR_ANY_AUTHENTICATED` carries
 * no role metadata at all.
 *
 * MAINTENANCE CONTRACT: a new endpoint, or any change to who may reach an
 * existing one, FAILS this test until a human edits this file. That edit is
 * the review artefact — it makes an authorisation change impossible to land
 * as a side effect of a refactor. Never "fix" a failure here by copying the
 * observed value in without asking whether the widening was intended.
 */

/** `METHOD /api/v1/path` (OpenAPI-style params) -> the exact `@Roles()` set. */
export const EXPECTED_ROUTE_ROLES: Readonly<Record<string, readonly string[]>> = {
  // ---- job lifecycle: recording and submitting results (JOB_RECORD_ROLES)
  'POST /api/v1/jobs/{jobId}/submit': ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'],
  'POST /api/v1/jobs/{jobId}/parts': ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'],
  'POST /api/v1/jobs/{jobId}/attachments': ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'],
  'POST /api/v1/jobs/{jobId}/recall': ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'],
  'PUT /api/v1/jobs/{jobId}/items/{templateItemId}': ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'],
  'PUT /api/v1/jobs/{jobId}/measurements/{templateMeasurementId}': [
    'MAINTAINER',
    'TEAM_LEADER',
    'ENGINEER',
  ],
  'POST /api/v1/sync/outbox': ['MAINTAINER', 'TEAM_LEADER', 'ENGINEER'],

  // ---- approval. PLANNER is deliberately ABSENT: separation of duties
  // (slice 18-WORKFLOW §3 — planning work and independently checking it are
  // different jobs). PLANNER is also on no `approval_stage_role`, so even a
  // change here could not make it a verifier.
  'POST /api/v1/jobs/{jobId}/verify': ['TEAM_LEADER', 'ENGINEER'],
  'POST /api/v1/jobs/{jobId}/return': ['TEAM_LEADER', 'ENGINEER'],
  'POST /api/v1/jobs/{jobId}/void': ['TEAM_LEADER', 'ENGINEER', 'ADMIN'],
  'POST /api/v1/delegations': ['TEAM_LEADER', 'ENGINEER', 'ADMIN'],
  'DELETE /api/v1/delegations/{delegationId}': ['TEAM_LEADER', 'ENGINEER', 'ADMIN'],

  // ---- planning (slice 18-WORKFLOW). PLANNER added ADDITIVELY — every role
  // that could reach these before is still listed.
  'POST /api/v1/jobs/adhoc': ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'],
  'POST /api/v1/jobs/{jobId}/assign': ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'],
  'PUT /api/v1/assets/{assetId}/schedule': ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'],

  // ---- organisation-wide bulk surfaces (ORG_REPORTING_ROLES). PLANNER is
  // deliberately ABSENT — review finding X-1. `POST /records/export` produces
  // a ZIP of PDFs carrying decrypted signatory names and signature images;
  // the reports are whole-plant aggregates. Neither is a per-row visibility
  // decision, so neither may ride on `JOB_VIEW_ALL_ROLES`.
  'POST /api/v1/records/export': ['TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'ADMIN', 'AUDITOR'],
  'GET /api/v1/exports/{exportId}': [
    'TEAM_LEADER',
    'ENGINEER',
    'DOC_CONTROLLER',
    'ADMIN',
    'AUDITOR',
  ],
  'GET /api/v1/exports/{exportId}/download': [
    'TEAM_LEADER',
    'ENGINEER',
    'DOC_CONTROLLER',
    'ADMIN',
    'AUDITOR',
  ],
  'GET /api/v1/reports/compliance': [
    'TEAM_LEADER',
    'ENGINEER',
    'DOC_CONTROLLER',
    'ADMIN',
    'AUDITOR',
  ],
  'GET /api/v1/reports/overdue': ['TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'ADMIN', 'AUDITOR'],
  'GET /api/v1/reports/pending': ['TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'ADMIN', 'AUDITOR'],
  'GET /api/v1/reports/measurements': [
    'TEAM_LEADER',
    'ENGINEER',
    'DOC_CONTROLLER',
    'ADMIN',
    'AUDITOR',
  ],

  // ---- reference data and template authoring
  'POST /api/v1/asset-types': ['ENGINEER', 'ADMIN'],
  'PATCH /api/v1/asset-types/{id}': ['ENGINEER', 'ADMIN'],
  'POST /api/v1/assets': ['ENGINEER', 'ADMIN'],
  'PATCH /api/v1/assets/{assetId}': ['ENGINEER', 'ADMIN'],
  'POST /api/v1/templates': ['ENGINEER', 'DOC_CONTROLLER'],
  'POST /api/v1/templates/{templateId}/revisions': ['ENGINEER', 'DOC_CONTROLLER'],
  'PATCH /api/v1/revisions/{revisionId}': ['ENGINEER', 'DOC_CONTROLLER'],
  'PUT /api/v1/revisions/{revisionId}/items': ['ENGINEER', 'DOC_CONTROLLER'],
  'PUT /api/v1/revisions/{revisionId}/measurements': ['ENGINEER', 'DOC_CONTROLLER'],
  'POST /api/v1/revisions/{revisionId}/submit': ['ENGINEER', 'DOC_CONTROLLER'],
  'POST /api/v1/revisions/{revisionId}/approve': ['DOC_CONTROLLER'],
  'POST /api/v1/revisions/{revisionId}/reject': ['DOC_CONTROLLER'],

  // ---- administration
  'POST /api/v1/areas': ['ADMIN'],
  'PATCH /api/v1/areas/{id}': ['ADMIN'],
  'GET /api/v1/users': ['ADMIN'],
  'POST /api/v1/users': ['ADMIN'],
  'GET /api/v1/users/{userId}': ['ADMIN'],
  'PATCH /api/v1/users/{userId}': ['ADMIN'],
  'POST /api/v1/users/{userId}/mfa-reset': ['ADMIN'],
  'PUT /api/v1/users/{userId}/area-scopes': ['ADMIN'],

  // ---- audit
  'GET /api/v1/audit-events/chain-status': ['AUDITOR', 'ADMIN'],
};

/**
 * Routes that carry NO `@Roles()` at all — reachable by any authenticated
 * caller (or, for the four in `PUBLIC_ROUTES`, unauthenticated).
 *
 * An unannotated handler admits EVERY authenticated user under `RolesGuard`,
 * so this list is a real authorisation statement, not an absence of one. Two
 * classes live here deliberately:
 *
 *  - reads whose authorisation is per-row rather than per-role — every
 *    job/record/queue/asset read runs through `JobAccessService`,
 *    `RecordsService#assertAccessible` or `AreaScopeService`, which is
 *    stricter than a role gate and is what `test:scope-coverage` polices;
 *  - global reference data (areas, asset types, templates, roles) and the
 *    caller's own session/credential endpoints.
 *
 * `GET /api/v1/assets/{assetId}/schedule` is here for a specific,
 * slice-18-documented reason: annotating it with a role list would have
 * REMOVED read access from MAINTAINER, DOC_CONTROLLER and AUDITOR, which
 * "add, never remove" forbids.
 */
export const ROUTES_WITHOUT_ROLE_GATES: readonly string[] = [
  'GET /api/v1/healthz',
  'GET /api/v1/.well-known/jwks.json',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/step-up',
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/password',
  'POST /api/v1/auth/mfa/enrol',
  'POST /api/v1/auth/mfa/enrol/confirm',
  'POST /api/v1/auth/mfa/verify',
  'POST /api/v1/auth/mfa/recovery',
  'GET /api/v1/areas',
  'GET /api/v1/areas/{id}',
  'GET /api/v1/asset-types',
  'GET /api/v1/asset-types/{id}',
  'GET /api/v1/approval-routes',
  'GET /api/v1/assets',
  'GET /api/v1/assets/{assetId}',
  'GET /api/v1/assets/{assetId}/history',
  'GET /api/v1/assets/{assetId}/schedule',
  'GET /api/v1/templates',
  'GET /api/v1/templates/{templateId}',
  'GET /api/v1/templates/{templateId}/revisions',
  'GET /api/v1/revisions/{revisionId}',
  'GET /api/v1/roles',
  'GET /api/v1/jobs',
  'GET /api/v1/jobs/{jobId}',
  'GET /api/v1/jobs/{jobId}/attachments/{attachmentId}',
  'GET /api/v1/queue',
  'GET /api/v1/delegations',
  'GET /api/v1/records',
  'GET /api/v1/records/{recordId}',
  'GET /api/v1/records/{recordId}/pdf',
  'GET /api/v1/records/{recordId}/integrity',
  'GET /api/v1/sync/bootstrap',
];
