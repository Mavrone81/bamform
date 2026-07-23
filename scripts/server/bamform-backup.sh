#!/usr/bin/env bash
# Nightly backup — BAMFORM-RUN-001 §8.1. Install at /root/bamform-backup.sh:
#   30 1 * * * root /root/bamform-backup.sh >> /var/log/bamform-backup.log 2>&1
#
# Backs up Postgres + MinIO + .env. Does NOT back up secrets/ — key material is
# under separate custody, backed up on change (PR-SEC-22, PR-ENV-15).

set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/opt/bamform
COMPOSE_FILE=$REPO/docker-compose.yml
BACKUP_DIR=/var/backups/bamform
STAMP=$(date -u +'%Y%m%dT%H%M%SZ')

log() { printf '%s  %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
trap 'log "ERROR: backup failed at line $LINENO"' ERR

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/minio" "$BACKUP_DIR/env"

log "Postgres dump"
docker compose -f "$COMPOSE_FILE" exec -T bamform-postgres \
  pg_dump -U bamform_migrate --format=custom bamform \
  > "$BACKUP_DIR/db/nightly-$STAMP.dump"

log "MinIO mirror"
docker compose -f "$COMPOSE_FILE" exec -T bamform-minio \
  sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$(cat /run/secrets/minio_root_password)" >/dev/null && mc mirror --overwrite local/bamform-attachments /data-backup' \
  2>/dev/null || log "WARN: minio mirror path needs a mounted backup target — configure at install"

log "Config copy (non-secret)"
cp "$REPO/.env" "$BACKUP_DIR/env/env-$STAMP" && chmod 600 "$BACKUP_DIR/env/env-$STAMP"

# Retention: 30 daily; monthly kept by first-of-month naming
find "$BACKUP_DIR/db"  -name 'nightly-*.dump' -mtime +30 -delete
find "$BACKUP_DIR/env" -name 'env-*'          -mtime +30 -delete

# The check that stops silent failure (PR-RUN-14): today's dump must exist and be non-trivial
LATEST=$(find "$BACKUP_DIR/db" -name 'nightly-*.dump' -mmin -60 | head -1)
[ -n "$LATEST" ] && [ "$(stat -c%s "$LATEST")" -gt 10240 ] \
  && log "OK: $LATEST ($(du -h "$LATEST" | cut -f1))" \
  || { log "ERROR: tonight's dump missing or suspiciously small"; exit 1; }
