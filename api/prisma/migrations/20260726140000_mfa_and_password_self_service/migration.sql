-- BamForm — slice 13-MFA: TOTP multi-factor authentication (BUILD_HANDOFF §5,
-- which moves MFA back into Release 1 and withdraws SEC RS-3) plus the
-- password self-service gap slice 13a deferred.
--
-- Forward-only, additive; does not edit any prior migration. INV-07: no
-- destructive DDL — nothing is dropped, narrowed or back-filled.
--
-- Reversal:
--   ALTER TABLE "app_user" DROP COLUMN "mfa_enrolled";
--   ALTER TABLE "app_user" DROP COLUMN "mfa_secret_ct";
--   ALTER TABLE "app_user" DROP COLUMN "mfa_secret_dek_version";
--   ALTER TABLE "app_user" DROP COLUMN "mfa_enrolled_at";
--   ALTER TABLE "app_user" DROP COLUMN "mfa_last_used_step";
--   ALTER TABLE "app_user" DROP COLUMN "must_change_password";
--   DROP TABLE "mfa_recovery_code";
-- (The `audit_action_t` values added by 20260726130000 are reversed
-- separately — see that migration's header.)
--
-- ============================================================ Why
--
-- DEPLOYMENT SAFETY. Every column below defaults to the value that means
-- "nothing changed for this row":
--
--   * `mfa_enrolled` defaults FALSE, so no existing user — including the sole
--     production ADMIN, samuel@vorkhive.com — is suddenly considered enrolled.
--   * `must_change_password` defaults FALSE, so no existing user is
--     retroactively forced through a password change. Deliberately NOT
--     back-filled to true for anyone (brief §7): the live admin must keep
--     being able to work. `POST /users` sets it to true for users created
--     from now on.
--
-- Enforcement itself is additionally gated at runtime by `MFA_ENABLED`, which
-- defaults to FALSE (`.env.example`, `api/src/auth/mfa/mfa.config.ts`). This
-- migration can therefore be applied to production ahead of the MFA UI
-- (slice 13-UI) with no behavioural change whatsoever.
--
-- `mfa_secret_ct` holds the AES-256-GCM ciphertext of the TOTP shared secret,
-- AAD-bound to `app_user:mfa_secret_ct:<row id>` via the established
-- field-encryption path (ADR-004 confines field encryption to `app_user`
-- personal columns; a personal authentication credential qualifies).
-- `mfa_secret_dek_version` is its OWN version column rather than reusing
-- `dek_version`: the MFA secret is written and replaced on a different
-- schedule to full_name/email/employee_id, and one shared version column
-- would force re-encrypting all four whenever any one of them changed.
--
-- `mfa_last_used_step` is the RFC 6238 §5.2 replay high-water mark — the
-- highest TOTP time step already accepted for this user. BIGINT because the
-- step is unix-seconds/30 and must not wrap.
--
-- `mfa_recovery_code` stores only `code_bidx`, the keyed HMAC-SHA-256 blind
-- index of the normalised code (same primitive and same file-mounted key as
-- `app_user.email_bidx`; see
-- `api/src/auth/crypto/blind-index.ts#computeRecoveryCodeBlindIndex` for why
-- a keyed digest rather than Argon2id is correct for a 160-bit CSPRNG
-- secret). The plaintext is returned once, at enrolment, and never stored.
-- `used_at` is the single-use marker: `bamform_app` has NO DELETE grant on
-- any table (INV-16, api/prisma/grants.sql) so a spent code is MARKED, never
-- removed, and the FK is ON DELETE RESTRICT for the same reason.
--
-- No `CONCURRENTLY` needed (M-06): `mfa_recovery_code` is brand new and empty
-- — its indexes are created with the table, and it is not one of the large
-- tables M-06 governs (audit_event / item_result / measurement_result / job).
--
-- Grants: `api/prisma/grants.sql` grants SELECT/INSERT/UPDATE on ALL TABLES
-- IN SCHEMA public, so the new table is covered the moment that script is
-- re-run after migration — which is exactly what CI and the deploy runbook
-- already do. No grants.sql change is required.

ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfa_secret_ct" BYTEA;
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfa_secret_dek_version" SMALLINT;
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfa_enrolled_at" TIMESTAMPTZ(6);
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfa_last_used_step" BIGINT;
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "mfa_recovery_code" (
  "id"         UUID           NOT NULL DEFAULT uuidv7(),
  "user_id"    UUID           NOT NULL,
  "code_bidx"  BYTEA          NOT NULL,
  "used_at"    TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mfa_recovery_code_code_bidx_key"
  ON "mfa_recovery_code" ("code_bidx");

CREATE INDEX IF NOT EXISTS "mfa_recovery_code_user_id_idx"
  ON "mfa_recovery_code" ("user_id");

-- ADD CONSTRAINT has no IF NOT EXISTS; guard it so `prisma migrate deploy`
-- re-runs cleanly (job 11 step (c) asserts idempotency).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mfa_recovery_code_user_id_fkey'
  ) THEN
    ALTER TABLE "mfa_recovery_code"
      ADD CONSTRAINT "mfa_recovery_code_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "app_user" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
