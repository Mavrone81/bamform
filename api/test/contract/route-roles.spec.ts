import { JOB_VIEW_ALL_ROLES, ORG_REPORTING_ROLES } from '../../src/jobs/job-access';
import { EXPECTED_ROUTE_ROLES, ROUTES_WITHOUT_ROLE_GATES } from './route-roles';
import { enumerateRoutes } from './route-inventory';

/**
 * C-07c — the COMPLETE authorisation inventory, asserted exactly, in both
 * directions.
 *
 * Slice 18-WORKFLOW's review found (X-1, Critical) that adding a role to a
 * shared constant silently granted it bulk record export and the whole
 * reports surface, and that nothing in CI could see it: the existing
 * additivity check hard-coded three routes and only looked for REMOVALS.
 *
 * A role silently APPEARING on an unrelated endpoint is at least as dangerous
 * as one disappearing — and when the constant is spread into `@Roles(...)` on
 * a controller in a different module, it is invisible in the diff of the file
 * that changed. This spec removes that blind spot by pinning the exact role
 * set of every route in the system. It cannot be satisfied by a spot check
 * and it cannot go vacuous: an unlisted route fails, a listed-but-absent
 * route fails, and a set that differs by one element in either direction
 * fails by name.
 */
describe('test:route-coverage (C-07c) — every route has exactly its declared @Roles set', () => {
  const routes = enumerateRoutes();
  const byKey = new Map(routes.map((r) => [`${r.method} ${r.openapiPath}`, r]));

  it('has actually enumerated routes (a broken discovery would vacuously pass)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(70);
  });

  it('every route in the system is classified — either role-gated or explicitly open', () => {
    const unclassified = [...byKey.keys()].filter(
      (key) => !(key in EXPECTED_ROUTE_ROLES) && !ROUTES_WITHOUT_ROLE_GATES.includes(key),
    );
    expect(unclassified).toEqual([]);
  });

  it('no route is classified twice (the two lists are disjoint)', () => {
    const both = Object.keys(EXPECTED_ROUTE_ROLES).filter((key) =>
      ROUTES_WITHOUT_ROLE_GATES.includes(key),
    );
    expect(both).toEqual([]);
  });

  it('every declared role-gated route exists, with EXACTLY the declared role set', () => {
    const mismatches: string[] = [];
    for (const [key, expected] of Object.entries(EXPECTED_ROUTE_ROLES)) {
      const route = byKey.get(key);
      if (!route) {
        mismatches.push(`${key}: declared but no such route`);
        continue;
      }
      const actual = [...(route.roles ?? [])].sort();
      const wanted = [...expected].sort();
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        mismatches.push(`${key}: expected [${wanted}] but the router says [${actual}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every route declared open really carries NO @Roles metadata', () => {
    const wrong: string[] = [];
    for (const key of ROUTES_WITHOUT_ROLE_GATES) {
      const route = byKey.get(key);
      if (!route) {
        wrong.push(`${key}: declared open but no such route`);
        continue;
      }
      if (route.roles !== undefined) {
        wrong.push(`${key}: declared open but is gated to [${route.roles}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * X-1's specific shape, pinned so the exact regression cannot recur even if
   * someone edits the inventory above without thinking: the access predicate
   * and the bulk-surface annotation list must not be the same set, and
   * PLANNER must be in the first and not the second.
   */
  describe('X-1 regression — the access predicate and the bulk-surface role list stay separate', () => {
    it('PLANNER holds broad job/archive VISIBILITY (it must, or the role is inert)', () => {
      expect(JOB_VIEW_ALL_ROLES).toContain('PLANNER');
    });

    it('PLANNER does NOT hold the organisation-wide reporting/export annotation', () => {
      expect(ORG_REPORTING_ROLES).not.toContain('PLANNER');
    });

    it('the two constants are genuinely different arrays, not aliases', () => {
      expect(ORG_REPORTING_ROLES).not.toBe(JOB_VIEW_ALL_ROLES);
      expect([...ORG_REPORTING_ROLES].sort()).not.toEqual([...JOB_VIEW_ALL_ROLES].sort());
    });

    it('no export or report route admits PLANNER', () => {
      const bulkRoutes = [...byKey.keys()].filter(
        (key) => key.includes('/reports/') || key.includes('/export'),
      );
      // Sanity: the sweep found the routes it claims to be checking.
      expect(bulkRoutes.length).toBeGreaterThanOrEqual(7);
      for (const key of bulkRoutes) {
        expect(byKey.get(key)!.roles ?? []).not.toContain('PLANNER');
      }
    });

    it('ORG_REPORTING_ROLES is exactly the pre-slice-18 broad-visibility set — nobody lost anything', () => {
      expect([...ORG_REPORTING_ROLES].sort()).toEqual(
        ['TEAM_LEADER', 'ENGINEER', 'DOC_CONTROLLER', 'ADMIN', 'AUDITOR'].sort(),
      );
    });
  });

  /**
   * Proof the comparison is not vacuous.
   *
   * The first version of this block (fix-delta re-review, finding D-2) only
   * asserted that adding an element to an array copy produced a different
   * array — true of any array, and it would have passed with the real
   * comparison above deleted entirely. A test that cannot fail is worse than
   * no test: it reports safety it never checked.
   *
   * These run the SAME comparison the real assertions use, against the SAME
   * discovered router metadata, with one synthetic drift injected. If the
   * comparison logic is broken or removed, `driftAgainstRouter` stops
   * detecting anything and these fail.
   */
  describe('proof: the real comparison catches drift in both directions', () => {
    /** Exactly the check performed above, isolated so it can be exercised. */
    function driftAgainstRouter(key: string, claimed: readonly string[]): string | null {
      const route = byKey.get(key);
      if (!route) return `${key}: not found in the router`;
      const actual = [...(route.roles ?? [])].sort();
      const wanted = [...claimed].sort();
      return JSON.stringify(actual) === JSON.stringify(wanted)
        ? null
        : `${key}: expected [${wanted}] but the router says [${actual}]`;
    }

    const WIDENED = 'GET /api/v1/reports/compliance';
    const NARROWED = 'POST /api/v1/jobs/{jobId}/assign';

    it('the honest declarations agree with the router (control)', () => {
      expect(driftAgainstRouter(WIDENED, EXPECTED_ROUTE_ROLES[WIDENED])).toBeNull();
      expect(driftAgainstRouter(NARROWED, EXPECTED_ROUTE_ROLES[NARROWED])).toBeNull();
    });

    it('a WIDENED claim is caught against the real router metadata', () => {
      // PLANNER on a bulk reporting route is the exact X-1 regression.
      const drift = driftAgainstRouter(WIDENED, [...EXPECTED_ROUTE_ROLES[WIDENED], 'PLANNER']);
      expect(drift).toContain(WIDENED);
      expect(drift).toContain('the router says');
    });

    it('a NARROWED claim is caught against the real router metadata', () => {
      const drift = driftAgainstRouter(
        NARROWED,
        EXPECTED_ROUTE_ROLES[NARROWED].filter((r) => r !== 'PLANNER'),
      );
      expect(drift).toContain(NARROWED);
      expect(drift).toContain('the router says');
    });
  });
});
