import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../../src/app.module';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import { ROLES_KEY } from '../../src/auth/decorators/roles.decorator';

/**
 * Route introspection used by `test:contract`/`test:route-coverage`/
 * `test:scope-coverage` (job 5) — CI job 5 has no Postgres/Redis service
 * container (unlike job 4's integration job), so these tests must NEVER
 * boot the real Nest application (`NestFactory.create`/`Test.createTestingModule
 * (...).compile()`): that would trigger `PrismaService#onModuleInit`'s
 * `$connect()` and `RedisModule`'s `ioredis` client construction, both of
 * which need a live server that does not exist in this job.
 *
 * Instead, this reads the SAME decorator metadata Nest's own router would —
 * `@Module({ imports, controllers })`, `@Controller(path)`,
 * `@Get/@Post/...(path)` — directly via `reflect-metadata`, which is
 * populated at class-definition (import) time, before any DI container
 * exists. Recursing through `AppModule`'s `imports` metadata (rather than a
 * hand-maintained controller list) means a new feature module wired into
 * `AppModule` is picked up automatically — the same wiring already required
 * for the module's routes to be served in production.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClass = new (...args: any[]) => unknown;

export interface RouteInfo {
  /** HTTP method, upper-case (`GET`, `POST`, ...). */
  method: string;
  /** Full path including the global prefix, Nest-style params (`:id`), e.g. `/api/v1/assets/:assetId`. */
  path: string;
  /** Same path with OpenAPI-style params (`{id}`), for comparison against `openapi.yaml`. */
  openapiPath: string;
  controller: string;
  handlerName: string;
  isPublic: boolean;
  roles: string[] | undefined;
}

/** Matches `main.ts`'s `app.setGlobalPrefix('api/v1')`. */
export const GLOBAL_PREFIX = 'api/v1';

function normaliseSegment(raw: string | string[] | undefined): string {
  if (raw === undefined) return '';
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
}

function joinPath(...segments: string[]): string {
  const joined = segments.filter((s) => s.length > 0).join('/');
  return `/${joined}`.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

function toOpenapiPath(nestPath: string): string {
  return nestPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Walks `AppModule`'s import graph, collecting every `@Module({ controllers })` entry. */
function discoverControllers(moduleClass: AnyClass, seen: Set<AnyClass> = new Set()): AnyClass[] {
  if (seen.has(moduleClass)) {
    return [];
  }
  seen.add(moduleClass);

  const imports: AnyClass[] =
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) as AnyClass[] | undefined) ?? [];
  const controllers: AnyClass[] =
    (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) as AnyClass[] | undefined) ?? [];

  const nested = imports.flatMap((imported) => discoverControllers(imported, seen));
  return [...controllers, ...nested];
}

function isRouteHandler(target: object, propertyKey: string): boolean {
  if (propertyKey === 'constructor') return false;
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  if (!descriptor || typeof descriptor.value !== 'function') return false;
  return Reflect.getMetadata(METHOD_METADATA, descriptor.value) !== undefined;
}

/**
 * Enumerates every route actually wired into `AppModule` — the ground truth
 * `test:contract` checks `api/openapi.yaml` against, and `test:route-coverage`
 * / `test:scope-coverage` classify.
 */
export function enumerateRoutes(): RouteInfo[] {
  const controllers = discoverControllers(AppModule as unknown as AnyClass);
  const routes: RouteInfo[] = [];

  for (const Controller of controllers) {
    const basePath = normaliseSegment(
      Reflect.getMetadata(PATH_METADATA, Controller) as string | string[] | undefined,
    );
    const classIsPublic = Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, Controller));
    const classRoles = Reflect.getMetadata(ROLES_KEY, Controller) as string[] | undefined;
    const proto = (Controller as { prototype: object }).prototype;

    for (const propertyKey of Object.getOwnPropertyNames(proto)) {
      if (!isRouteHandler(proto, propertyKey)) continue;
      const handler = (proto as Record<string, (...args: unknown[]) => unknown>)[propertyKey];

      const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (methodMeta === undefined) continue;

      const handlerPath = normaliseSegment(
        Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined,
      );
      const fullPath = joinPath(GLOBAL_PREFIX, basePath, handlerPath);

      const handlerIsPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined;
      const isPublic = handlerIsPublic !== undefined ? Boolean(handlerIsPublic) : classIsPublic;

      const handlerRoles = Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined;
      const roles = handlerRoles ?? classRoles;

      routes.push({
        method: RequestMethod[methodMeta] ?? 'GET',
        path: fullPath,
        openapiPath: toOpenapiPath(fullPath),
        controller: Controller.name,
        handlerName: propertyKey,
        isPublic,
        roles,
      });
    }
  }

  return routes;
}
