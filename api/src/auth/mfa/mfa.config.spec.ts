import { ConfigService } from '@nestjs/config';
import { PasswordPolicyConfig } from '../password/password-policy.config';
import { DEFAULT_MFA_REQUIRED_ROLES, MfaConfig } from './mfa.config';

function configFor(env: Record<string, unknown>): MfaConfig {
  return new MfaConfig(new ConfigService(env));
}

/**
 * U-MFA-07 — the `MFA_ENABLED` safety property (brief §2). This is the single
 * most important behaviour in the slice: production is live, its only account
 * is ADMIN, and the MFA UI does not exist yet.
 */
describe('U-MFA-07 MfaConfig.enabled defaults to false', () => {
  it('is false when MFA_ENABLED is absent', () => {
    expect(configFor({}).enabled).toBe(false);
  });

  it.each([['false'], ['FALSE'], ['0'], [''], ['no'], ['off'], ['1'], ['yes']])(
    'treats MFA_ENABLED=%p as OFF — only the literal "true" enables it',
    (value) => {
      expect(configFor({ MFA_ENABLED: value }).enabled).toBe(false);
    },
  );

  it.each([['true'], ['TRUE'], ['True']])('treats MFA_ENABLED=%p as on', (value) => {
    expect(configFor({ MFA_ENABLED: value }).enabled).toBe(true);
  });

  it('an ADMIN is NOT subject to MFA while the flag is off — the live-admin lockout guard', () => {
    expect(configFor({}).isMfaRequiredForRoles(['ADMIN'])).toBe(false);
    expect(configFor({ MFA_ENABLED: 'false' }).isMfaRequiredForRoles(['ADMIN'])).toBe(false);
  });
});

describe('U-MFA-08 MFA_REQUIRED_ROLES (D-1/D-4)', () => {
  const on = { MFA_ENABLED: 'true' };

  it('defaults to the D-1 list, which does NOT include MAINTAINER', () => {
    expect([...configFor(on).requiredRoles].sort()).toEqual(
      ['ADMIN', 'AUDITOR', 'DOC_CONTROLLER', 'ENGINEER', 'TEAM_LEADER'].sort(),
    );
    expect(DEFAULT_MFA_REQUIRED_ROLES).not.toContain('MAINTAINER');
  });

  it.each([['ADMIN'], ['TEAM_LEADER'], ['ENGINEER'], ['DOC_CONTROLLER'], ['AUDITOR']])(
    '%s is subject to MFA when the flag is on',
    (role) => {
      expect(configFor(on).isMfaRequiredForRoles([role])).toBe(true);
    },
  );

  it('MAINTAINER alone is EXEMPT even with the flag on (SEC RS-3 / SO-3)', () => {
    expect(configFor(on).isMfaRequiredForRoles(['MAINTAINER'])).toBe(false);
  });

  it('a user who is MAINTAINER *and* TEAM_LEADER is subject to it — any required role counts', () => {
    expect(configFor(on).isMfaRequiredForRoles(['MAINTAINER', 'TEAM_LEADER'])).toBe(true);
  });

  it('a user with no roles at all is not subject to it', () => {
    expect(configFor(on).isMfaRequiredForRoles([])).toBe(false);
  });

  it('parses the CSV override, trimming and upper-casing', () => {
    const config = configFor({ ...on, MFA_REQUIRED_ROLES: ' admin , team_leader ' });
    expect(config.requiredRoles).toEqual(['ADMIN', 'TEAM_LEADER']);
    expect(config.isMfaRequiredForRoles(['ENGINEER'])).toBe(false);
    expect(config.isMfaRequiredForRoles(['ADMIN'])).toBe(true);
  });

  it('falls back to the default list when the override is blank rather than exempting everyone', () => {
    expect(configFor({ ...on, MFA_REQUIRED_ROLES: '   ' }).requiredRoles).toEqual(
      DEFAULT_MFA_REQUIRED_ROLES,
    );
  });
});

describe('U-MFA-09 rate limits (brief §6)', () => {
  it('defaults match the brief: verify 10/min, recovery 5/min, password 10/min, enrol 10/min', () => {
    const config = configFor({});
    expect(config.verifyRateLimitPerMinute).toBe(10);
    expect(config.recoveryRateLimitPerMinute).toBe(5);
    expect(config.passwordChangeRateLimitPerMinute).toBe(10);
    // M-4: /auth/mfa/enrol had no limit at all before the fix pass.
    expect(config.enrolRateLimitPerMinute).toBe(10);
  });

  it('honours env overrides', () => {
    const config = configFor({
      RATE_LIMIT_MFA_VERIFY_PER_MIN: '3',
      RATE_LIMIT_MFA_RECOVERY_PER_MIN: '2',
      RATE_LIMIT_PASSWORD_CHANGE_PER_MIN: '4',
      RATE_LIMIT_MFA_ENROL_PER_MIN: '5',
    });
    expect(config.verifyRateLimitPerMinute).toBe(3);
    expect(config.recoveryRateLimitPerMinute).toBe(2);
    expect(config.passwordChangeRateLimitPerMinute).toBe(4);
    expect(config.enrolRateLimitPerMinute).toBe(5);
  });
});

/**
 * U-MFA-10 — the SECOND deployment-safety switch (review finding I-3).
 * `FORCE_PASSWORD_CHANGE_ENABLED` gates whether `POST /users` marks a new
 * account `must_change_password`. The password-change screen ships in slice
 * 13-UI, so forcing the change before then hard-locks the first user created
 * after deploy. Held to exactly the strictness the reviewer verified for
 * `MFA_ENABLED`, by sharing its parser.
 */
describe('U-MFA-10 PasswordPolicyConfig.forceChangeOnAdminCreatedUsers defaults to false', () => {
  function policyFor(env: Record<string, unknown>): PasswordPolicyConfig {
    return new PasswordPolicyConfig(new ConfigService(env));
  }

  it('is false when FORCE_PASSWORD_CHANGE_ENABLED is absent', () => {
    expect(policyFor({}).forceChangeOnAdminCreatedUsers).toBe(false);
  });

  it.each([['false'], ['FALSE'], ['0'], [''], ['no'], ['off'], ['1'], ['yes'], ['true ']])(
    'treats FORCE_PASSWORD_CHANGE_ENABLED=%p as OFF — only the literal "true" enables it',
    (value) => {
      expect(
        policyFor({ FORCE_PASSWORD_CHANGE_ENABLED: value }).forceChangeOnAdminCreatedUsers,
      ).toBe(false);
    },
  );

  it.each([['true'], ['TRUE'], ['True']])(
    'treats FORCE_PASSWORD_CHANGE_ENABLED=%p as on',
    (value) => {
      expect(
        policyFor({ FORCE_PASSWORD_CHANGE_ENABLED: value }).forceChangeOnAdminCreatedUsers,
      ).toBe(true);
    },
  );

  it('is parsed by the SAME helper as MFA_ENABLED, so the two cannot drift', () => {
    for (const value of [undefined, '', '0', '1', 'yes', 'on', 'false', 'true', 'TRUE']) {
      expect(
        policyFor({ FORCE_PASSWORD_CHANGE_ENABLED: value }).forceChangeOnAdminCreatedUsers,
      ).toBe(configFor({ MFA_ENABLED: value }).enabled);
    }
  });
});
