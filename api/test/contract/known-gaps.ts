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
  // verifier-queue UI's read endpoint) is explicitly OUT of slice 7's scope
  // (slice-7-brief.md Constraints: "Do NOT build the verifier-queue UI
  // (slice 11)") — stays allowlisted for slice 11.
  { method: 'GET', path: '/queue' },
  // Slice 9 — sync API: bootstrap, outbox, idempotency store
  { method: 'GET', path: '/sync/bootstrap' },
  { method: 'POST', path: '/sync/outbox' },
  // Slice 12 — PDF render, archive search/export, reports/trending
  { method: 'GET', path: '/records/{recordId}/pdf' },
  { method: 'GET', path: '/reports/measurements' },
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
];
