#!/bin/bash
# BamForm database login roles — BAMFORM-DBD-001 §7.1.
# Runs ONCE at first initialisation of the postgres volume
# (docker-entrypoint-initdb.d), as the superuser POSTGRES_USER.
#
# The control that matters — bamform_app holds NO UPDATE or DELETE on
# audit_event or approval_step (PR-099, PR-115) — is applied later by
# api/prisma/grants.sql (run by the migrate service after the tables exist).
# This script only creates the three LOGIN roles with their real passwords,
# read from file-mounted docker secrets (never env vars, never logged).
set -euo pipefail

app_password="$(cat /run/secrets/app_password)"
readonly_password="$(cat /run/secrets/readonly_password)"
backup_password="$(cat /run/secrets/backup_password)"

psql -v ON_ERROR_STOP=1 \
  -v app_password="$app_password" \
  -v readonly_password="$readonly_password" \
  -v backup_password="$backup_password" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE bamform_app      LOGIN PASSWORD :'app_password';
CREATE ROLE bamform_readonly LOGIN PASSWORD :'readonly_password';
CREATE ROLE bamform_backup   LOGIN PASSWORD :'backup_password';

GRANT CONNECT ON DATABASE bamform TO bamform_app, bamform_readonly, bamform_backup;
GRANT USAGE   ON SCHEMA public    TO bamform_app, bamform_readonly, bamform_backup;
EOSQL
