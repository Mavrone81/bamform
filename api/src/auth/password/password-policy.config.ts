import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEnvFlagEnabled } from '../../common/env-flag';

/**
 * ⚠️ `FORCE_PASSWORD_CHANGE_ENABLED` DEFAULTS TO FALSE, AND — LIKE
 * `MFA_ENABLED` — THAT IS A DEPLOYMENT-SAFETY REQUIREMENT, NOT A PREFERENCE.
 *
 * Slice 13-MFA §7 closes a real slice-13a gap: an ADMIN chooses a new user's
 * password, so the ADMIN knows that user's credential indefinitely, which
 * makes signature attribution under ISO 13485 indefensible. The fix is
 * `must_change_password` plus a global deny-by-default guard that blocks a
 * forced-change user from everything except `GET /auth/me`,
 * `POST /auth/password` and `POST /auth/logout`.
 *
 * The hazard the brief's §2 analysis missed (review finding I-3) is that the
 * PASSWORD-CHANGE SCREEN does not exist either — it lands in slice 13-UI,
 * exactly as the MFA screens do. Ship the forcing before the screen and the
 * first technician Samuel creates on `form.bevorasg.com` logs in
 * successfully, then gets `403 /errors/password-change-required` from every
 * page, with no UI able to clear it. The escape would be a hand-crafted
 * `POST /auth/password` or an admin edit of the database.
 *
 * So the same mitigation the owner already accepted for MFA applies here:
 *
 * - The column, the endpoint, the guard, the audit event and every test SHIP
 *   and stay exercised. Only the act of SETTING the flag on newly created
 *   users is gated.
 * - With the switch off, `POST /users` creates users exactly as slice 13a
 *   did. Nobody can be locked out by a screen that does not exist yet.
 * - With it on, the §7 behaviour applies in full, unchanged.
 * - Nothing in committed configuration sets it to `true`. Flipping it is a
 *   deliberate post-13-UI step, alongside `MFA_ENABLED`.
 *
 * Gating the SETTING rather than the GUARD is deliberate: the guard stays
 * live, so any row that already carries `must_change_password` — set by hand,
 * or by a future back-fill — is still honoured, and the deny-by-default
 * property is never dormant.
 */
@Injectable()
export class PasswordPolicyConfig {
  constructor(private readonly config: ConfigService) {}

  /**
   * Whether `POST /users` marks the new account `must_change_password`.
   * Default false. Only the literal `"true"` enables it (`isEnvFlagEnabled`),
   * the same strictness `MFA_ENABLED` is held to.
   */
  get forceChangeOnAdminCreatedUsers(): boolean {
    return isEnvFlagEnabled(this.config.get('FORCE_PASSWORD_CHANGE_ENABLED'));
  }
}
