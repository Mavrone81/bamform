import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEnvFlagEnabled } from '../../common/env-flag';

/**
 * Brief §1 D-1: the roles for which a second factor is mandatory.
 * `MAINTAINER` is deliberately ABSENT and must stay absent — SEC §14 RS-3's
 * surviving rationale is that "full MFA on gloved hands in a cleanroom is a
 * usability problem that would push users back to paper", and SO-3 (adoption)
 * outranks it. The exemption is the reason MFA could be moved into Release 1
 * at all.
 */
export const DEFAULT_MFA_REQUIRED_ROLES: readonly string[] = [
  'ADMIN',
  'TEAM_LEADER',
  'ENGINEER',
  'DOC_CONTROLLER',
  'AUDITOR',
];

/**
 * ⚠️ `MFA_ENABLED` DEFAULTS TO FALSE, AND THAT IS A HARD REQUIREMENT, NOT A
 * CONVENIENCE (brief §2).
 *
 * `form.bevorasg.com` is live and its ONLY account, samuel@vorkhive.com, is
 * `ADMIN` — a role D-1 makes MFA-mandatory. The MFA screens do not exist
 * until slice 13-UI. If enforcement went live with this slice, the next
 * auto-deploy would demand a TOTP code at login that no screen can collect,
 * and lock the sole administrator out of production.
 *
 * So: with the flag off, `/auth/login` behaves EXACTLY as it does today —
 * same branch, same response shape, no challenge, no enrolment requirement.
 * The enrol endpoints still work, so a user may enrol voluntarily ahead of
 * time, but nobody is ever challenged or blocked. Turning it on is a
 * deliberate post-13-UI step Samuel takes; nothing in committed config sets
 * it to true.
 */
@Injectable()
export class MfaConfig {
  constructor(private readonly config: ConfigService) {}

  /**
   * Master switch for ALL enforcement. Default false — see the class comment.
   * Parsed by the shared `isEnvFlagEnabled` so this flag and
   * `FORCE_PASSWORD_CHANGE_ENABLED` (`PasswordPolicyConfig`) cannot drift into
   * two different notions of "true".
   */
  get enabled(): boolean {
    return isEnvFlagEnabled(this.config.get('MFA_ENABLED'));
  }

  /** D-4: `MFA_REQUIRED_ROLES`, CSV, defaulting to the D-1 list. */
  get requiredRoles(): readonly string[] {
    const raw = this.config.get<string>('MFA_REQUIRED_ROLES');
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return DEFAULT_MFA_REQUIRED_ROLES;
    }
    return String(raw)
      .split(',')
      .map((role) => role.trim().toUpperCase())
      .filter((role) => role.length > 0);
  }

  /**
   * D-1: "A user holding *any* required role is subject to MFA." A user who
   * is both MAINTAINER and TEAM_LEADER is therefore subject to it — the
   * exemption is for people who ONLY do shop-floor work.
   */
  isMfaRequiredForRoles(roles: readonly string[]): boolean {
    if (!this.enabled) {
      return false;
    }
    const required = new Set(this.requiredRoles);
    return roles.some((role) => required.has(role));
  }

  get verifyRateLimitPerMinute(): number {
    return Number(this.config.get('RATE_LIMIT_MFA_VERIFY_PER_MIN') ?? 10);
  }

  /**
   * `POST /auth/mfa/enrol`. Added in the fix pass (review finding M-4) — the
   * endpoint had no limit at all, and it is reachable on a challenge token,
   * i.e. with the password alone.
   */
  get enrolRateLimitPerMinute(): number {
    return Number(this.config.get('RATE_LIMIT_MFA_ENROL_PER_MIN') ?? 10);
  }

  get recoveryRateLimitPerMinute(): number {
    return Number(this.config.get('RATE_LIMIT_MFA_RECOVERY_PER_MIN') ?? 5);
  }

  get passwordChangeRateLimitPerMinute(): number {
    return Number(this.config.get('RATE_LIMIT_PASSWORD_CHANGE_PER_MIN') ?? 10);
  }

  get issuer(): string {
    return this.config.get<string>('MFA_TOTP_ISSUER') ?? 'BamForm';
  }
}
