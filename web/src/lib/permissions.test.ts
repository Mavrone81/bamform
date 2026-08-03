import { describe, expect, it } from 'vitest';
import {
  ADJUST_SCHEDULE_ROLES,
  RAISE_JOB_ROLES,
  rolesCanAdjustSchedule,
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
