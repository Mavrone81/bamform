import { describe, expect, it } from 'vitest';
import {
  ADJUST_SCHEDULE_ROLES,
  ASSIGN_JOB_ROLES,
  RAISE_JOB_ROLES,
  rolesCanAdjustSchedule,
  rolesCanAssignJob,
  rolesCanRaiseJob,
} from './permissions';

/**
 * Slice 18-WORKFLOW §2/§3. These predicates are PRESENTATION ONLY — the
 * server's `@Roles()` guard is the gate (non-negotiable #6) — so what is
 * actually worth pinning is that the client offers the action to exactly the
 * roles the server permits, and that slice 18's change was ADDITIVE.
 */
describe('rolesCanRaiseJob (POST /jobs/adhoc)', () => {
  it('offers the action to PLANNER and to every role that could already raise work', () => {
    for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN']) {
      expect(rolesCanRaiseJob([role])).toBe(true);
    }
  });

  it('does not offer it to roles the server refuses', () => {
    for (const role of ['MAINTAINER', 'DOC_CONTROLLER', 'AUDITOR']) {
      expect(rolesCanRaiseJob([role])).toBe(false);
    }
  });

  it('handles a signed-out / not-yet-loaded user without throwing', () => {
    expect(rolesCanRaiseJob(undefined)).toBe(false);
    expect(rolesCanRaiseJob([])).toBe(false);
  });

  it('a multi-role user needs only one permitted role', () => {
    expect(rolesCanRaiseJob(['MAINTAINER', 'PLANNER'])).toBe(true);
  });

  it('mirrors the server list exactly — ADDITIVE: TEAM_LEADER/ENGINEER/ADMIN retained', () => {
    expect([...RAISE_JOB_ROLES].sort()).toEqual(
      ['ADMIN', 'ENGINEER', 'PLANNER', 'TEAM_LEADER'].sort(),
    );
  });
});

describe('rolesCanAdjustSchedule (PUT /assets/{assetId}/schedule)', () => {
  it('offers the action to exactly PLANNER, TEAM_LEADER, ENGINEER, ADMIN', () => {
    for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN']) {
      expect(rolesCanAdjustSchedule([role])).toBe(true);
    }
  });

  it('does not offer it to a role the server refuses — read-only for them', () => {
    for (const role of ['MAINTAINER', 'DOC_CONTROLLER', 'AUDITOR']) {
      expect(rolesCanAdjustSchedule([role])).toBe(false);
    }
  });

  it('handles a signed-out / not-yet-loaded user without throwing', () => {
    expect(rolesCanAdjustSchedule(undefined)).toBe(false);
    expect(rolesCanAdjustSchedule([])).toBe(false);
  });

  it('a multi-role user needs only one permitted role', () => {
    expect(rolesCanAdjustSchedule(['MAINTAINER', 'ENGINEER'])).toBe(true);
  });

  it('mirrors the server `@Roles()` list exactly', () => {
    expect([...ADJUST_SCHEDULE_ROLES].sort()).toEqual(
      ['ADMIN', 'ENGINEER', 'PLANNER', 'TEAM_LEADER'].sort(),
    );
  });
});

/**
 * Slice 32-PLANNERJOB — `POST /jobs/{jobId}/assign` and its picker
 * `GET /schedule/{scheduleRuleId}/assignable-users`.
 */
describe('rolesCanAssignJob (POST /jobs/{jobId}/assign)', () => {
  it('offers the action to exactly PLANNER, TEAM_LEADER, ENGINEER, ADMIN', () => {
    for (const role of ['PLANNER', 'TEAM_LEADER', 'ENGINEER', 'ADMIN']) {
      expect(rolesCanAssignJob([role])).toBe(true);
    }
  });

  /**
   * MAINTAINER is the pointed one: a maintainer DOES the work and may record
   * results on a job assigned to them, but may not decide who work goes to.
   */
  it('does not offer it to a role the server refuses', () => {
    for (const role of ['MAINTAINER', 'DOC_CONTROLLER', 'AUDITOR']) {
      expect(rolesCanAssignJob([role])).toBe(false);
    }
  });

  it('handles a signed-out / not-yet-loaded user without throwing', () => {
    expect(rolesCanAssignJob(undefined)).toBe(false);
    expect(rolesCanAssignJob([])).toBe(false);
  });

  it('a multi-role user needs only one permitted role', () => {
    expect(rolesCanAssignJob(['MAINTAINER', 'PLANNER'])).toBe(true);
  });

  it('mirrors the server `@Roles()` list exactly', () => {
    expect([...ASSIGN_JOB_ROLES].sort()).toEqual(
      ['ADMIN', 'ENGINEER', 'PLANNER', 'TEAM_LEADER'].sort(),
    );
  });

  /**
   * THE REASON THIS IS ITS OWN CONSTANT rather than an alias of
   * `ADJUST_SCHEDULE_ROLES`. The two lists are identical TODAY and mirror two
   * different `@Roles()` declarations on two different controllers; sharing
   * one array would mean a future narrowing of either silently narrowing the
   * other. This asserts they are separate objects, so collapsing them fails
   * here rather than in production.
   */
  it('is a separate constant from the schedule-adjust list, not the same array', () => {
    expect(ASSIGN_JOB_ROLES).not.toBe(ADJUST_SCHEDULE_ROLES);
    expect(ASSIGN_JOB_ROLES).not.toBe(RAISE_JOB_ROLES);
  });
});
