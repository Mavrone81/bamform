import { enumerateRoutes } from './route-inventory';
import { findPublicDrift } from './contract-checks';
import { PUBLIC_ROUTES } from './known-gaps';

/**
 * C-07 (threat E-6) — "Every route authenticated unless allowlisted" (job 5,
 * step 4). `api/src/auth/guards/jwt-auth.guard.ts` is registered globally
 * (`APP_GUARD`), so every route is authenticated UNLESS `@Public()` —
 * this test enumerates the router (see `route-inventory.ts`) and checks
 * `@Public()` metadata against `known-gaps.ts`'s named `PUBLIC_ROUTES`
 * constant in BOTH directions: a route can't be silently marked `@Public()`
 * without being named here, and a named entry can't silently stop being
 * public (stale allowlist).
 */
describe('test:route-coverage (C-07) — every route requires auth unless named-allowlisted', () => {
  const routes = enumerateRoutes();

  it('has actually enumerated routes (sanity)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(30);
  });

  it('no route is @Public() without an explicit, named allowlist entry', () => {
    const { publicButNotAllowlisted } = findPublicDrift(routes, PUBLIC_ROUTES);
    expect(publicButNotAllowlisted.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('every allowlisted entry is a real route that is actually @Public()', () => {
    const { allowlistedButNotPublic, allowlistedButMissing } = findPublicDrift(
      routes,
      PUBLIC_ROUTES,
    );
    expect(allowlistedButNotPublic).toEqual([]);
    expect(allowlistedButMissing).toEqual([]);
  });

  it('every non-allowlisted route requires authentication (isPublic is false)', () => {
    const shouldBeAuthenticated = routes.filter(
      (route) =>
        !PUBLIC_ROUTES.some((entry) => entry.method === route.method && entry.path === route.path),
    );
    for (const route of shouldBeAuthenticated) {
      expect(route.isPublic).toBe(false);
    }
  });

  // ---- Proof this genuinely catches a violation ----
  // Manual RED/GREEN verification: temporarily adding `@Public()` to
  // `AssetsController#list` (a real, security-sensitive handler) and
  // re-running `npm run test:route-coverage --workspace=api` reproduced this
  // exact failure ("no route is @Public() without an explicit allowlist
  // entry" reported `GET /api/v1/assets`), then the decorator was removed and
  // the suite went green again (see ci-B-report.md). Pinned permanently here
  // via a synthetic fixture so a refactor of `findPublicDrift` can't quietly
  // make the check vacuous.
  describe('proof: findPublicDrift catches both directions of drift', () => {
    it('flags a route marked @Public() with no allowlist entry', () => {
      const fakeRoutes = [{ method: 'GET', path: '/api/v1/assets', isPublic: true }];
      const drift = findPublicDrift(fakeRoutes, []);
      expect(drift.publicButNotAllowlisted).toEqual(fakeRoutes);
    });

    it('flags an allowlist entry whose route is not actually @Public()', () => {
      const fakeRoutes = [{ method: 'GET', path: '/api/v1/healthz', isPublic: false }];
      const drift = findPublicDrift(fakeRoutes, [{ method: 'GET', path: '/api/v1/healthz' }]);
      expect(drift.allowlistedButNotPublic).toEqual([{ method: 'GET', path: '/api/v1/healthz' }]);
    });

    it('flags a stale allowlist entry with no matching route', () => {
      const drift = findPublicDrift([], [{ method: 'GET', path: '/api/v1/nonexistent' }]);
      expect(drift.allowlistedButMissing).toEqual([{ method: 'GET', path: '/api/v1/nonexistent' }]);
    });
  });
});
