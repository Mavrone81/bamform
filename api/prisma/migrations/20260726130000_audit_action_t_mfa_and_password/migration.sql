-- BamForm — slice 13-MFA (§8): additive `audit_action_t` values for the
-- credential-lifecycle events TOTP enrolment and password self-service
-- introduce. No existing value carries their meaning — `login`/`login_failed`
-- are authentication-ATTEMPT outcomes and `permission_change` is about roles.
--
-- Reversal: Postgres cannot drop a single enum value in place. To reverse,
-- first ensure no `audit_event` row uses any of the four values below (they
-- are INSERT/SELECT-only via bamform_app — MfaService and
-- PasswordChangeService are the only writers), then recreate `audit_action_t`
-- without them: `CREATE TYPE audit_action_t_new AS ENUM (...the other
-- values...); ALTER TABLE audit_event ALTER COLUMN action TYPE
-- audit_action_t_new USING action::text::audit_action_t_new; DROP TYPE
-- audit_action_t; ALTER TYPE audit_action_t_new RENAME TO audit_action_t;` —
-- not scripted here per M-04 (documented, not automated, since it requires
-- confirming no row depends on the values first).
--
-- Additive/forward-only (M-04): only ADDS values, touches no existing rows or
-- columns. `IF NOT EXISTS` makes it idempotent on re-run.
--
-- This is its own migration, separate from
-- `20260726140000_mfa_and_password_self_service`, following the pattern
-- `20260725010000_audit_action_t_chain_break_detected` set: Postgres forbids
-- USING a freshly-added enum value in the same transaction that added it.
-- Nothing here uses the values; the application does, over a later
-- connection, so it is unaffected.
ALTER TYPE "audit_action_t" ADD VALUE IF NOT EXISTS 'mfa_enrolled';
ALTER TYPE "audit_action_t" ADD VALUE IF NOT EXISTS 'mfa_reset';
ALTER TYPE "audit_action_t" ADD VALUE IF NOT EXISTS 'mfa_recovery_code_used';
ALTER TYPE "audit_action_t" ADD VALUE IF NOT EXISTS 'password_changed';
