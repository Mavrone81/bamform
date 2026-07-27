import { z } from 'zod';

/**
 * Slice 13a (UR-072/073, PR-037) — user/role administration DTOs. Mirrors
 * `api/openapi.yaml` `/users`, `/roles` schemas exactly (ADR-002: same rule
 * client and server validate against).
 *
 * The six roles are seeded by migration, not created through the API
 * (`api/prisma/migrations/20260723180100_seed_reference_data`'s comment:
 * "role ... is seeded by migration, not manual") — this enum is the closed
 * set `role.code` can ever hold today.
 */
export const roleCodeSchema = z.enum([
  'MAINTAINER',
  'TEAM_LEADER',
  'ENGINEER',
  'DOC_CONTROLLER',
  'ADMIN',
  'AUDITOR',
]);
export type RoleCode = z.infer<typeof roleCodeSchema>;

/** `api/openapi.yaml` `Role` schema — the `GET /roles` catalogue (UR-073). */
export const roleSchema = z.object({
  id: z.string().uuid(),
  code: roleCodeSchema,
  name: z.string(),
  description: z.string().nullable().optional(),
});
export type Role = z.infer<typeof roleSchema>;

/** `api/openapi.yaml` `UserStatus` — mirrors DBD `user_status_t`. */
export const userStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);
export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * `api/openapi.yaml` `User` schema — PR-037. NEVER carries `passwordHash` or
 * any password material (UR-074's server-side enforcement includes never
 * leaking a credential over this or any other read path).
 */
export const userSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().nullable().optional(),
  fullName: z.string(),
  email: z.string().email(),
  status: userStatusSchema,
  /** Derived from `status === 'ACTIVE'` — the deactivation flag PR-039/UR-075 requires in place of hard delete. */
  active: z.boolean(),
  roles: z.array(roleCodeSchema),
  /**
   * Slice 13-UI-B (SYS-10) — the user's ACTIVE area scopes (PR-API-10).
   * `[]` means UNRESTRICTED (sees every area), mirroring the read side's
   * "absence of rows means unrestricted". Written via
   * `PUT /users/{userId}/area-scopes`; soft-removed rows never appear here.
   */
  areaIds: z.array(z.string().uuid()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

/**
 * `api/openapi.yaml` `UserCreate` schema — `POST /users`, ADMIN only.
 * `password`: this slice's documented minimal mechanism is
 * **admin-set** (not a generated temp-password/invite-email flow — there is
 * no SMTP wiring until slice 11's credentials land and no forced
 * "must-change" gate exists in `/auth/login` yet, see slice-13a-report.md
 * "concerns"). Same length policy as `loginRequestSchema` (`auth.ts`) so the
 * client validates against one rule, not two.
 */
export const userCreateSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  employeeId: z.string().trim().min(1).max(50).optional(),
  password: z.string().min(12),
  roleCodes: z.array(roleCodeSchema).min(1),
});
export type UserCreate = z.infer<typeof userCreateSchema>;

/**
 * `api/openapi.yaml` `UserUpdate` schema — `PATCH /users/{userId}`.
 * PR-039/UR-075: no hard delete — `active: false` is the only removal
 * mechanism. `roleCodes`, when present, REPLACES the user's role set
 * wholesale (produces a `permission_change` audit event per
 * API_SPECIFICATION.md §10.9, distinct from the `update` event any other
 * field change produces).
 */
export const userUpdateSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().optional(),
  active: z.boolean().optional(),
  roleCodes: z.array(roleCodeSchema).min(1).optional(),
});
export type UserUpdate = z.infer<typeof userUpdateSchema>;

/**
 * `api/openapi.yaml` `UserAreaScopeSet` — `PUT /users/{userId}/area-scopes`
 * (slice 13-UI-B, SYS-10: the write path that makes PR-API-10's read-side
 * enforcement reachable). REPLACES the user's area-scope set wholesale, the
 * same way `UserUpdate.roleCodes` replaces roles. `[]` is legal and means
 * "unrestricted" (clears every scope). Removal is a soft-remove
 * (`user_area_scope.active = false`, INV-16: no DELETE grant), and the
 * change produces a `permission_change` audit event.
 */
export const userAreaScopeSetSchema = z.object({
  areaIds: z.array(z.string().uuid()),
});
export type UserAreaScopeSet = z.infer<typeof userAreaScopeSetSchema>;
