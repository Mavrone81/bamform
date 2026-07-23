-- BamForm database roles and grants — BAMFORM-DBD-001 §7.1
-- Runs once at first initialisation of the postgres volume.
--
-- The control that matters: bamform_app holds NO UPDATE or DELETE on
-- audit_event or approval_step (PR-099, PR-115). An application-layer
-- compromise therefore cannot silently rewrite history.

\set ON_ERROR_STOP on

-- Application role — used by api and worker
CREATE ROLE bamform_app      LOGIN PASSWORD :'app_password';
-- Read-only role — used by the AUDITOR path and reporting (PR-API-09)
CREATE ROLE bamform_readonly LOGIN PASSWORD :'readonly_password';
-- Backup role
CREATE ROLE bamform_backup   LOGIN PASSWORD :'backup_password';

GRANT CONNECT ON DATABASE bamform TO bamform_app, bamform_readonly, bamform_backup;
GRANT USAGE   ON SCHEMA public    TO bamform_app, bamform_readonly, bamform_backup;

-- Applied after migrations create the tables; see api/prisma/grants.sql,
-- which the migrate service runs as its final step.
