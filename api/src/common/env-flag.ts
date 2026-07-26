/**
 * The ONE way a deployment-safety master switch is read from the environment.
 *
 * Only the literal string `"true"` (any case) enables. Absent, `""`, `"0"`,
 * `"1"`, `"yes"`, `"on"` and every other value are OFF. That strictness is
 * the point, not pedantry: these flags gate behaviour that can lock the sole
 * production administrator out of `form.bevorasg.com`, so the failure mode of
 * a typo, a half-written `.env` line or a truthy-looking value must be
 * "stays off", never "quietly on".
 *
 * Extracted in the slice-13-MFA fix pass so `MFA_ENABLED` and
 * `FORCE_PASSWORD_CHANGE_ENABLED` cannot drift apart — the reviewer verified
 * `MFA_ENABLED`'s parsing case by case (U-MFA-07), and a second flag with its
 * own hand-rolled coercion would put that verification back to zero.
 */
export function isEnvFlagEnabled(raw: unknown): boolean {
  return String(raw ?? 'false').toLowerCase() === 'true';
}
