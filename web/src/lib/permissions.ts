/**
 * Presentation-only role predicates (non-negotiable #6: the client NEVER
 * enforces authorisation — the server's `@Roles()` guard does, and every
 * route stays reachable by URL so a refusal is the server's own 403,
 * surfaced verbatim). These exist purely so the app does not offer an action
 * that will obviously be refused.
 *
 * They mirror the server's `@Roles()` lists by hand, which is a deliberate
 * duplication: the alternative is shipping the permission matrix to the
 * client and inviting it to be treated as authority.
 */

/**
 * `POST /jobs/adhoc` — `jobs.controller.ts#createAdhoc`. Slice 18-WORKFLOW
 * added PLANNER; TEAM_LEADER/ENGINEER/ADMIN were already permitted to raise
 * work and keep that right.
 */
export const RAISE_JOB_ROLES = ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const;

export function rolesCanRaiseJob(roles: readonly string[] | undefined): boolean {
  return roles?.some((role) => (RAISE_JOB_ROLES as readonly string[]).includes(role)) ?? false;
}

/**
 * `PUT /assets/{assetId}/schedule` — `asset-schedule.controller.ts#adjustSchedule`.
 * `GET` carries no `@Roles()` at all (everyone may read a schedule), so there
 * is no `rolesCanReadSchedule` to mirror — only the write side needs gating.
 */
export const ADJUST_SCHEDULE_ROLES = ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const;

export function rolesCanAdjustSchedule(roles: readonly string[] | undefined): boolean {
  return (
    roles?.some((role) => (ADJUST_SCHEDULE_ROLES as readonly string[]).includes(role)) ?? false
  );
}
