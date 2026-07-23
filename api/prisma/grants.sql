-- BamForm — role grants. BAMFORM-DBD-001 §7.1.
--
-- Applied AFTER migrations create the tables — NOT part of the Prisma
-- migration history (`prisma migrate deploy` never runs this file). Wired
-- the way .github/workflows/ci.yml's "Apply role grants" step expects:
--   psql "$DATABASE_URL" -f api/prisma/grants.sql
--
-- In production the restricted roles already exist — created by
-- db/init/01-roles.sql with real secret-backed passwords, before the
-- migrate service ever runs. This script does not manage passwords; it only
-- (re)applies privileges, so it is safe to run against either a roles-already-
-- exist database (production) or a fresh one that has none yet (CI, whose
-- ephemeral Postgres service is just `postgres:16-alpine` with no init
-- scripts). See slice-1-report.md for the one open gap this leaves: nothing
-- in docker-compose.yml's `bamform-migrate` command currently invokes this
-- file in production.
--
-- Idempotent: REVOKE-then-GRANT the full DBD §7.1 privilege set every run,
-- so re-running after a schema change never accumulates stale privileges.

-- CI/dev-bootstrap-only fallback, never used in production: the passwords
-- below are literal, committed, and therefore public. They exist solely so
-- this script also works unattended against CI's bare `postgres:16-alpine`
-- service container, which has no init scripts and so does not pre-create
-- these roles. In production the roles already exist — provisioned by
-- db/init/01-roles.sql with real, secret-backed passwords, before the
-- migrate service (and this script) ever runs — so the `IF NOT EXISTS`
-- guards below are no-ops there and these fallback passwords are never
-- applied to a production role. Do not rely on this block outside CI/local
-- dev, and do not "fix" production auth by pointing it at these values.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bamform_app') THEN
    CREATE ROLE bamform_app LOGIN PASSWORD 'bamform_app_ci_only_not_a_real_secret';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bamform_readonly') THEN
    CREATE ROLE bamform_readonly LOGIN PASSWORD 'bamform_readonly_ci_only_not_a_real_secret';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bamform_backup') THEN
    CREATE ROLE bamform_backup LOGIN PASSWORD 'bamform_backup_ci_only_not_a_real_secret';
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO bamform_app, bamform_readonly, bamform_backup',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO bamform_app, bamform_readonly, bamform_backup;

-- Start from nothing, then grant exactly the DBD §7.1 set.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM bamform_app, bamform_readonly, bamform_backup;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM bamform_app, bamform_readonly, bamform_backup;

-- bamform_readonly / bamform_backup — SELECT only, everywhere (§7.1).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bamform_readonly, bamform_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO bamform_readonly, bamform_backup;

-- bamform_app — SELECT/INSERT/UPDATE on mutable tables. INV-16: DELETE is
-- never granted, on anything, full stop.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO bamform_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bamform_app;

-- INV-10 / INV-11: the two append-only tables get SELECT + INSERT only —
-- no UPDATE, no DELETE, for the application role.
REVOKE UPDATE ON "audit_event", "approval_step" FROM bamform_app;

-- Explicit, defence-in-depth restatement of INV-16 (redundant with the
-- REVOKE ALL above, but keeps the non-negotiable readable at a glance without
-- having to trace the grant/revoke sequence).
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM bamform_app;
