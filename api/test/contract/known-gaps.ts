/**
 * Named, reviewed exceptions for the contract/coverage tests (job 5). Every
 * entry here is a conscious classification, not a silent skip — BUILD_HANDOFF
 * §4 non-negotiable #6 ("the route-coverage test enumerates from the router,
 * so new endpoints are auto-covered") is exactly why these are named
 * constants rather than per-route `// eslint-disable`-style exceptions: a
 * new route that doesn't fit an existing entry FAILS the relevant test until
 * a human adds a classification here, with a reason.
 */

export interface MethodPath {
  method: string;
  path: string;
}

/**
 * `api/openapi.yaml` documents the FULL 13-slice system up front (see
 * `docs/BUILD_HANDOFF.md` §3's build order and `.superpowers/sdd/progress.md`
 * — "openapi.yaml is now IN SCOPE to extend additively every slice"). Only
 * slices 1-4 (health/auth/areas/asset-types/assets/templates/revisions) are
 * implemented so far. `test:contract`'s "every openapi path is implemented"
 * direction would otherwise permanently fail until slice 13 for reasons that
 * have nothing to do with THIS slice's work — these paths are real,
 * deliberately-documented future work, not an undocumented-vs-implemented
 * defect. Each entry names the slice that is expected to implement it
 * (`docs/BUILD_HANDOFF.md` §3's build-order table); shrink this list as
 * slices land, per the standing CI rule in `.superpowers/sdd/progress.md`.
 */
export const FUTURE_SLICE_OPENAPI_PATHS: readonly MethodPath[] = [
  // Slice 8 — richer liveness+readiness (health.controller.ts: "the full
  // dist/healthcheck.js is built out with the rest of the runtime in later
  // slices"). `/healthz` (the ACTUAL slice-1 probe) is documented separately
  // and is not in this list. `GET /audit-events/chain-status` moved OUT of
  // this allowlist — slice 8 implements it (AuditEventsController).
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/ready' },
  // Slice 6 — jobs, results, parts, attachments, submission gate — DONE.
  // GET /jobs, GET /jobs/{jobId}, PUT items/measurements, POST attachments,
  // POST submit moved out of this allowlist (implemented, contract-enforced
  // below); GET /jobs/{jobId}/attachments/{attachmentId} and
  // POST /jobs/{jobId}/parts are new paths added to openapi.yaml alongside
  // the implementation, not documented-then-implemented, so they never
  // needed an allowlist entry.
  // Slice 7 — approval — DONE. POST verify/return/recall/void and
  // GET /records/{recordId}/integrity moved out of this allowlist
  // (implemented, contract-enforced below; recall/void are new paths added
  // to openapi.yaml alongside their implementation, same as slice 6's note
  // above, so they never needed an allowlist entry either). GET /queue (the
  // verifier-queue UI's read endpoint) was allowlisted here for slice 11 —
  // slice 11a (backend) implements it now, so it moved OUT of this list.
  // GET/POST /delegations, DELETE /delegations/{delegationId} — slice 11a,
  // implemented alongside GET /queue; added to openapi.yaml with the impl,
  // never allowlisted (same convention as slice 6/7's new paths above).
  // Slice 9 — sync API: bootstrap, outbox, idempotency store — DONE.
  // GET /sync/bootstrap and POST /sync/outbox moved OUT of this allowlist
  // (implemented, contract-enforced below).
  // Slice 12 — PDF render, archive search/export, reports/trending — DONE.
  // GET /records/{recordId}/pdf and GET /reports/measurements moved OUT of
  // this allowlist (implemented, contract-enforced below). GET /records,
  // GET /records/{recordId}, POST /records/export, GET /exports/{exportId},
  // GET /exports/{exportId}/download, GET /reports/compliance|overdue|pending
  // are new paths added to openapi.yaml alongside their implementation
  // (same convention as slice 6/7/9/11a's new paths — never allowlisted).
  // Slice 13a — user/role administration + machine-code provisional
  // generation — DONE. GET/POST /users, GET/PATCH /users/{userId},
  // GET /roles are new paths added to openapi.yaml alongside their
  // implementation (same convention as above — never allowlisted here).
];

/**
 * PR-API-05 / PR-SEC-05 (`api/src/auth/decorators/public.decorator.ts`):
 * "every endpoint except /auth/login, /auth/refresh, /health and
 * /.well-known/jwks.json". The literal implemented liveness path is
 * `/healthz` (slice 1; see `known-gaps.ts` note above and
 * `health.controller.ts`), so it replaces `/health` here — this list is the
 * ground truth for what `@Public()` is ALLOWED to mark, checked against the
 * router's actual `@Public()` metadata by `route-coverage.spec.ts`.
 */
export const PUBLIC_ROUTES: readonly MethodPath[] = [
  { method: 'GET', path: '/api/v1/healthz' },
  { method: 'GET', path: '/api/v1/.well-known/jwks.json' },
  { method: 'POST', path: '/api/v1/auth/login' },
  { method: 'POST', path: '/api/v1/auth/refresh' },
];

/**
 * Slice 13-MFA introduced a SECOND authentication class,
 * `@MfaChallengeAuth(mode)` (`api/src/auth/decorators/mfa-challenge-auth.decorator.ts`),
 * and the fix pass added this allowlist for it (review finding M-6).
 *
 * Why it needs its own list rather than riding on `PUBLIC_ROUTES`: such a
 * route is NOT `@Public()` — it demands a signed, audience-pinned, unexpired,
 * non-denylisted token — so C-07's `isPublic === false` check passes and says
 * nothing. But the principal it establishes is a challenge token, not an
 * access token: `request.user` stays unset, there is no `roles` claim, and
 * `PasswordChangeRequiredGuard` therefore returns early. Every one of those is
 * correct for a mid-login route and wrong for anything else, and until this
 * list existed nothing in CI would have noticed the decorator appearing on a
 * fifth route. Checked in BOTH directions, exactly as `PUBLIC_ROUTES` is.
 *
 * `challenge-only` = finishes a login and accepts nothing else.
 * `challenge-or-access` = also serves an already-signed-in user.
 */
export interface MfaChallengeRoute extends MethodPath {
  mode: 'challenge-only' | 'challenge-or-access';
}

export const MFA_CHALLENGE_ROUTES: readonly MfaChallengeRoute[] = [
  { method: 'POST', path: '/api/v1/auth/mfa/enrol', mode: 'challenge-or-access' },
  { method: 'POST', path: '/api/v1/auth/mfa/enrol/confirm', mode: 'challenge-or-access' },
  { method: 'POST', path: '/api/v1/auth/mfa/verify', mode: 'challenge-only' },
  { method: 'POST', path: '/api/v1/auth/mfa/recovery', mode: 'challenge-only' },
];

/**
 * PR-API-10 / ADR-005 / `api/src/common/area-scope.ts`: scoping applies to
 * collection reads over an entity that HAS an `areaId` column. Per
 * `.superpowers/sdd/slice-4-report.md`: "assets is the only PR-019..028
 * entity with an areaId column; areas/asset-types/templates/revisions are
 * global reference data with nothing to scope by." `scope-coverage.spec.ts`
 * discovers candidate collection endpoints by the repo's own naming
 * convention (handler name starts with `list`) and requires EVERY discovered
 * candidate to appear here, classified, with a reason — an unclassified
 * `list*` handler fails the test until someone adds it here (or implements
 * scoping and marks it `areaScoped: true` with `sourceFile` pointing at the
 * repository that calls `applyAreaScope`).
 */
export interface CollectionEndpointClassification {
  method: string;
  path: string;
  areaScoped: boolean;
  reason: string;
  /** Required when `areaScoped: true` — the repository file that must call `applyAreaScope`. */
  sourceFile?: string;
}

export const COLLECTION_ENDPOINTS: readonly CollectionEndpointClassification[] = [
  {
    method: 'GET',
    path: '/api/v1/areas',
    areaScoped: false,
    reason: 'area (DBD §6.1) has no areaId column — it IS the scope source, not scoped by it.',
  },
  {
    method: 'GET',
    path: '/api/v1/asset-types',
    areaScoped: false,
    reason: 'asset_type (DBD §6.7) is global reference data with no areaId column.',
  },
  {
    method: 'GET',
    path: '/api/v1/approval-routes',
    areaScoped: false,
    reason:
      'approval_route (DBD §6.13) is seeded global reference data (PR-DBD-09) with no areaId ' +
      'column — added by slice 13-TL so POST /asset-types can resolve approvalRouteId over HTTP.',
  },
  {
    method: 'GET',
    path: '/api/v1/assets',
    areaScoped: true,
    reason: 'asset.areaId exists (DBD §6.8); PR-API-10 requires filtering by user_area_scope.',
    sourceFile: 'src/assets/assets.repository.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/templates',
    areaScoped: false,
    reason: 'form_template (DBD §6.9) is global reference data with no areaId column.',
  },
  {
    method: 'GET',
    path: '/api/v1/templates/{templateId}/revisions',
    areaScoped: false,
    reason: 'template_revision (DBD §6.10) is global reference data with no areaId column.',
  },
  {
    method: 'GET',
    path: '/api/v1/jobs',
    areaScoped: true,
    reason:
      'job (DBD §6.15) has no areaId column of its own, but job.asset.areaId does — PR-API-10 requires filtering by user_area_scope through that relation. (A role-driven "own jobs only" restriction also applies for MAINTAINER — see src/jobs/job-access.ts — but that is a role rule, not the area-scope mechanism this check verifies.)',
    sourceFile: 'src/jobs/jobs.repository.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/records',
    areaScoped: true,
    reason:
      'Slice 12 — an archived record IS a job row (status=ARCHIVED); same area-scope mechanism as GET /jobs, applied through job.asset.areaId. (MAINTAINER is additionally restricted to their own records — records.service.ts#hasBroadArchiveVisibility — a role rule, not the area-scope mechanism this check verifies.)',
    sourceFile: 'src/records/records.repository.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/delegations',
    areaScoped: false,
    reason:
      "delegation (DBD §6.5) has no areaId column and is not filtered by area — it is filtered by IDENTITY (the caller's own grants, either direction, src/delegations/delegations.repository.ts#findForUser), an orthogonal mechanism to PR-API-10 area scoping.",
  },
  {
    method: 'GET',
    path: '/api/v1/users',
    areaScoped: false,
    reason:
      'app_user (DBD §6.2/6.3) has no areaId column. user_area_scope is the REVERSE relation (which areas a user may operate in), not a property of the user row itself to filter the admin listing by — API_SPECIFICATION.md §10.9 documents /users as "ADMIN only" with no area restriction, unlike GET /assets\' explicit PR-API-10 note. ADMIN administers users system-wide.',
  },
  {
    method: 'GET',
    path: '/api/v1/roles',
    areaScoped: false,
    reason: 'role (DBD §6.3) is global reference data, seeded by migration, with no areaId column.',
  },
  {
    method: 'GET',
    path: '/api/v1/schedule',
    areaScoped: true,
    reason:
      'Slice 31-PLANNER — the cross-machine planner grid. schedule_rule (DBD §6.14) has no areaId column of its own, but schedule_rule.assetDocument.asset.areaId does, so PR-API-10 filtering runs through that relation — the same shape GET /jobs already scopes through job.asset.areaId. This one matters more than most: it is the ONLY endpoint that returns rows for every machine in the plant in one response, so a missing filter here would hand a scoped planner the whole site rather than one extra row.',
    sourceFile: 'src/scheduling/planner-schedule.repository.ts',
  },
  {
    method: 'GET',
    path: '/api/v1/schedule/{scheduleRuleId}/assignable-users',
    areaScoped: false,
    reason:
      "Slice 32-PLANNERJOB — who a machine's PM may be given to. app_user (DBD §6.2/6.3) has no areaId column, exactly as GET /users is classified above; user_area_scope is the REVERSE relation. This read IS area-filtered, but by the MACHINE's area against each candidate's own scope (assignable-user.service.ts#list, the SQL form of assertAssignable's rule) — the opposite direction to PR-API-10's applyAreaScope, which filters rows BY the caller's scope, and not expressible by it. The caller's own confidentiality boundary is the SCHEDULE RULE, not the user list: PlannerScheduleService#loadRuleInScope runs first and answers 404 for an unknown rule and 403 out-of-scope for a machine the caller cannot see, so this can only ever be read for a machine they already hold.",
  },
];
