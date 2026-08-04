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

/**
 * `POST /jobs/{jobId}/assign` (`jobs.controller.ts#assign`) and its picker
 * `GET /schedule/{scheduleRuleId}/assignable-users`
 * (`planner-schedule.controller.ts#listAssignableUsers`).
 *
 * ITS OWN CONSTANT, even though the membership is character-for-character
 * `ADJUST_SCHEDULE_ROLES` today. It mirrors a DIFFERENT `@Roles()` declaration
 * on a different controller, and the two answer different questions: "who may
 * move a due date" and "who may hand work to a technician". `RAISE_JOB_ROLES`
 * above already sets this precedent — it too has the same four members and is
 * deliberately not shared. Collapsing them would mean a future narrowing of
 * one silently narrowing the others, in a file whose whole purpose is to
 * mirror the server rather than to model permissions itself.
 *
 * Presentation only (non-negotiable #6): both routes stay reachable and the
 * server's own 403 is what actually refuses.
 */
export const ASSIGN_JOB_ROLES = ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN'] as const;

export function rolesCanAssignJob(roles: readonly string[] | undefined): boolean {
  return roles?.some((role) => (ASSIGN_JOB_ROLES as readonly string[]).includes(role)) ?? false;
}
