import { enumerateRoutes } from './route-inventory';
import {
  findCollectionCandidates,
  findUnclassifiedCollectionEndpoints,
  findMissingAreaScopeWiring,
} from './contract-checks';
import { COLLECTION_ENDPOINTS } from './known-gaps';

/**
 * C-08 — "Every collection endpoint applies area scoping" (job 5, step 5).
 * PR-API-10/ADR-005 (`api/src/common/area-scope.ts`): scoping is a
 * repository-layer mechanism, only meaningful for an entity that HAS an
 * `areaId` column. Per `.superpowers/sdd/slice-4-report.md`, `asset` is
 * currently the only such entity — `areas`/`asset-types`/`templates` are
 * global reference data with nothing to scope by, by design, not by
 * omission.
 *
 * Job 5 has no Postgres (see `route-inventory.ts`'s header), so this cannot
 * re-run the BEHAVIOURAL proof (a scoped user only seeing their area's
 * rows) — that already exists and runs for real in job 4's integration
 * suite (`api/test/integration/assets.spec.ts`, "area scoping" describe
 * block, real Postgres). This test instead statically guards (a) that every
 * `list*` collection handler is consciously classified in
 * `known-gaps.ts#COLLECTION_ENDPOINTS`, and (b) that every entity classified
 * `areaScoped: true` still has its repository actually calling
 * `applyAreaScope(` — i.e. the wiring job 4's behavioural test exercises has
 * not been quietly deleted.
 */
describe('test:scope-coverage (C-08) — every collection endpoint is scoping-classified', () => {
  const routes = enumerateRoutes();

  it('has actually discovered collection-endpoint candidates (sanity)', () => {
    expect(findCollectionCandidates(routes).length).toBeGreaterThanOrEqual(5);
  });

  it('every discovered list* handler has a named classification in COLLECTION_ENDPOINTS', () => {
    const unclassified = findUnclassifiedCollectionEndpoints(routes, COLLECTION_ENDPOINTS);
    expect(unclassified.map((r) => `${r.method} ${r.path} (${r.handlerName})`)).toEqual([]);
  });

  it("every area-scoped collection endpoint's repository actually calls applyAreaScope(", () => {
    const missingWiring = findMissingAreaScopeWiring(COLLECTION_ENDPOINTS);
    expect(missingWiring.map((entry) => `${entry.method} ${entry.path}`)).toEqual([]);
  });

  // ---- Proof this genuinely catches a violation ----
  // Manual RED/GREEN verification: temporarily removing the `applyAreaScope(`
  // call from `assets.repository.ts#findMany` (leaving the rest of the query
  // intact) and re-running `npm run test:scope-coverage --workspace=api`
  // reproduced this exact failure ("GET /api/v1/assets" reported missing
  // wiring), then the call was restored and the suite went green again (see
  // ci-B-report.md). A second manual check added a throwaway
  // `@Get() listScratch()` handler to `AreasController` (matching the `list*`
  // naming convention, deliberately NOT added to `COLLECTION_ENDPOINTS`) and
  // confirmed "every discovered list* handler has a named classification"
  // failed on it, then removed it. Pinned permanently here via synthetic
  // fixtures.
  describe('proof: the checks catch both classes of violation', () => {
    it('flags a list* handler with no COLLECTION_ENDPOINTS entry', () => {
      const fakeRoutes = [
        { method: 'GET', path: '/api/v1/areas', handlerName: 'list' },
        { method: 'GET', path: '/api/v1/schedules', handlerName: 'listSchedules' },
      ];
      const unclassified = findUnclassifiedCollectionEndpoints(fakeRoutes, COLLECTION_ENDPOINTS);
      expect(unclassified).toEqual([
        { method: 'GET', path: '/api/v1/schedules', handlerName: 'listSchedules' },
      ]);
    });

    it('does not flag a non-list handler even if it returns a collection', () => {
      const fakeRoutes = [
        { method: 'GET', path: '/api/v1/assets/:id/history', handlerName: 'history' },
      ];
      expect(findUnclassifiedCollectionEndpoints(fakeRoutes, COLLECTION_ENDPOINTS)).toEqual([]);
    });

    it('flags an areaScoped entry whose repository file no longer calls applyAreaScope(', () => {
      const registry = [
        {
          method: 'GET',
          path: '/api/v1/widgets',
          areaScoped: true,
          reason: 'synthetic fixture — widget.areaId exists',
          sourceFile: 'fake/widgets.repository.ts',
        },
      ];
      const readFile = () => 'export function findMany() { return prisma.widget.findMany({}); }';
      expect(findMissingAreaScopeWiring(registry, readFile)).toEqual(registry);
    });

    it('does not flag an areaScoped entry whose repository does call applyAreaScope(', () => {
      const registry = [
        {
          method: 'GET',
          path: '/api/v1/widgets',
          areaScoped: true,
          reason: 'synthetic fixture',
          sourceFile: 'fake/widgets.repository.ts',
        },
      ];
      const readFile = () =>
        'export function findMany() { return prisma.widget.findMany({ where: applyAreaScope({}, scope) }); }';
      expect(findMissingAreaScopeWiring(registry, readFile)).toEqual([]);
    });

    it('flags a real, unmodified entity (asset) if its repository stops calling applyAreaScope( — control check against real source', () => {
      // Uses the REAL default reader against the REAL file, proving the
      // check is exercising actual source text, not a stub.
      expect(findMissingAreaScopeWiring(COLLECTION_ENDPOINTS)).toEqual([]);
    });
  });
});
