import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_PREFIX } from './route-inventory';
import { pathsMatch } from './path-match';
import type { CollectionEndpointClassification, MethodPath } from './known-gaps';

/**
 * Pure comparison functions used by `contract.spec.ts` / `route-coverage.spec.ts`
 * / `scope-coverage.spec.ts` AND by their own `*.proof.spec.ts` siblings,
 * which feed synthetic fixtures through the SAME functions to demonstrate
 * they genuinely catch a violation (undocumented route / unauthenticated
 * route missing from the allowlist / unscoped collection endpoint) rather
 * than being vacuously true. Kept dependency-free (no Nest, no DI) so they
 * run without booting anything.
 */

function stripGlobalPrefix(path: string): string {
  const prefixed = `/${GLOBAL_PREFIX}`;
  return path.startsWith(prefixed) ? path.slice(prefixed.length) || '/' : path;
}

export interface RouteLike {
  method: string;
  path: string; // Nest-style, WITH global prefix (as RouteInfo#path)
}

export interface OpLike {
  method: string;
  path: string; // openapi-style, WITHOUT global prefix (as OpenapiOperation#path)
}

/** Direction 1 — every implemented route must be documented. */
export function findUndocumentedRoutes<R extends RouteLike>(
  routes: readonly R[],
  openapiOps: readonly OpLike[],
): R[] {
  return routes.filter(
    (route) =>
      !openapiOps.some(
        (op) => op.method === route.method && pathsMatch(stripGlobalPrefix(route.path), op.path),
      ),
  );
}

/** Direction 2 — every documented path must be implemented, unless explicitly future work. */
export function findUnimplementedOpenapiPaths<O extends OpLike, R extends RouteLike>(
  openapiOps: readonly O[],
  routes: readonly R[],
  futureAllowlist: readonly MethodPath[],
): O[] {
  return openapiOps.filter((op) => {
    const implemented = routes.some(
      (route) => route.method === op.method && pathsMatch(stripGlobalPrefix(route.path), op.path),
    );
    if (implemented) return false;
    const isFutureWork = futureAllowlist.some(
      (entry) => entry.method === op.method && pathsMatch(entry.path, op.path),
    );
    return !isFutureWork;
  });
}

export interface PublicDrift<R extends RouteLike> {
  /** Routes marked `@Public()` that are NOT in the named allowlist. */
  publicButNotAllowlisted: R[];
  /** Allowlist entries that don't correspond to an actually-`@Public()` route. */
  allowlistedButNotPublic: MethodPath[];
  /** Allowlist entries with no matching route at all (stale entry). */
  allowlistedButMissing: MethodPath[];
}

/** C-07 — the public-route allowlist must match reality exactly, in both directions. */
export function findPublicDrift<R extends RouteLike & { isPublic: boolean }>(
  routes: readonly R[],
  allowlist: readonly MethodPath[],
): PublicDrift<R> {
  const publicButNotAllowlisted = routes.filter(
    (route) =>
      route.isPublic &&
      !allowlist.some(
        (entry) => entry.method === route.method && pathsMatch(entry.path, route.path),
      ),
  );

  const allowlistedButNotPublic: MethodPath[] = [];
  const allowlistedButMissing: MethodPath[] = [];
  for (const entry of allowlist) {
    const match = routes.find(
      (route) => route.method === entry.method && pathsMatch(entry.path, route.path),
    );
    if (!match) {
      allowlistedButMissing.push(entry);
    } else if (!match.isPublic) {
      allowlistedButNotPublic.push(entry);
    }
  }

  return { publicButNotAllowlisted, allowlistedButNotPublic, allowlistedButMissing };
}

/**
 * C-08 — candidate "collection" endpoints, discovered by the repo's own
 * naming convention (every implemented list handler is named `list` or
 * `listForTemplate`; see `areas.controller.ts`/`asset-types.controller.ts`/
 * `assets.controller.ts`/`templates.controller.ts`/`revisions.controller.ts`).
 * BUILD_HANDOFF §4 non-negotiable #6 says route-coverage/scope-coverage must
 * auto-discover from the router rather than a hand list — this is that
 * discovery step for scope-coverage.
 */
export function findCollectionCandidates<R extends RouteLike & { handlerName: string }>(
  routes: readonly R[],
): R[] {
  return routes.filter((route) => route.method === 'GET' && /^list/i.test(route.handlerName));
}

/** Candidates discovered that have no entry in `COLLECTION_ENDPOINTS` at all. */
export function findUnclassifiedCollectionEndpoints<R extends RouteLike & { handlerName: string }>(
  routes: readonly R[],
  registry: readonly CollectionEndpointClassification[],
): R[] {
  return findCollectionCandidates(routes).filter(
    (route) =>
      !registry.some(
        (entry) => entry.method === route.method && pathsMatch(entry.path, route.path),
      ),
  );
}

/**
 * For every registry entry marked `areaScoped: true`, statically confirms
 * its `sourceFile` actually calls `applyAreaScope(` — a real (if narrow)
 * regression check that the repository-layer wiring hasn't been quietly
 * deleted. (Job 5 has no Postgres, so the BEHAVIOURAL proof — a scoped user
 * only seeing their area's rows — lives in the job-4 integration suite,
 * `api/test/integration/assets.spec.ts`'s "area scoping" tests, which run
 * against real Postgres; this check guards the wiring those tests exercise.)
 */
export function findMissingAreaScopeWiring(
  registry: readonly CollectionEndpointClassification[],
  readFile: (path: string) => string = (path) =>
    readFileSync(join(__dirname, '..', '..', path), 'utf8'),
): CollectionEndpointClassification[] {
  return registry.filter((entry) => {
    if (!entry.areaScoped) return false;
    if (!entry.sourceFile) return true; // areaScoped without a sourceFile to check is itself a defect
    const contents = readFile(entry.sourceFile);
    // `applyAreaScope<Prisma.XWhereInput>(...)` (generic type arg) or the
    // plain `applyAreaScope(...)` call — either counts as "actually wired".
    return !/applyAreaScope\s*[(<]/.test(contents);
  });
}
