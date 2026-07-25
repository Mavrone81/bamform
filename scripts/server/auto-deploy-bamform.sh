#!/usr/bin/env bash
# BamForm CD — server-side pull deploy. BAMFORM-RUN-001 §4.
# Install at /root/auto-deploy-bamform.sh, invoked by cron under flock:
#   * * * * * flock -n /tmp/bamform-deploy.lock /root/auto-deploy-bamform.sh >> /var/log/bamform-deploy.log 2>&1
#
# SAFETY PROPERTIES (do not weaken):
#   - migration failure aborts WITHOUT restarting the app (PR-RUN-07)
#   - only bamform-* services are ever named (PR-006, PR-RUN-08)
#   - no automatic rollback — a failed health check alerts and stops (ADR-012)
#   - volumes and .env are git-ignored and never touched

set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/opt/bamform
COMPOSE_FILE=$REPO/docker-compose.yml
SERVICES="bamform-api bamform-worker bamform-web"
BACKUP_DIR=/var/backups/bamform
# shellcheck disable=SC1091
[ -f "$REPO/.env" ] && set -a && . "$REPO/.env" && set +a
HEALTH_URL="http://127.0.0.1:${API_PORT:?API_PORT not set in .env}/api/v1/healthz"

log()  { printf '%s  %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "ERROR: $*"; exit 1; }
trap 'log "ERROR: line $LINENO failed"' ERR

cd "$REPO" || fail "repo not found at $REPO"
git fetch origin main --quiet || fail "git fetch failed"

LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

log "=== Deploy start: ${LOCAL:0:7} -> ${REMOTE:0:7} ==="

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +'%Y%m%dT%H%M%SZ')
log "Pre-migration backup"
docker compose -f "$COMPOSE_FILE" exec -T bamform-postgres \
  pg_dump -U bamform_migrate --format=custom bamform \
  > "$BACKUP_DIR/predeploy-$STAMP.dump" || fail "pre-deploy backup failed — deploy aborted"
find "$BACKUP_DIR" -name 'predeploy-*.dump' -mtime +7 -delete

git reset --hard origin/main --quiet
log "Working tree at $(git rev-parse --short HEAD)"

log "Building"
docker compose -f "$COMPOSE_FILE" build $SERVICES \
  || fail "build failed — nothing restarted"

log "Migrating"
# --build is REQUIRED: the migrate image carries api/prisma/migrations, but the
# build step above only builds $SERVICES (api/worker/web). Without --build,
# `run` reuses a stale migrate image that lacks the new slice's migration, so
# `prisma migrate deploy` reports "up to date" and silently skips it. (This bit
# slice 7 in prod: 21 migrations on disk, 20 applied, migrate image 12h stale.)
docker compose -f "$COMPOSE_FILE" run --rm --build bamform-migrate \
  || fail "MIGRATION FAILED — app NOT restarted; previous version still serving"

log "Restarting BamForm services only"
docker compose -f "$COMPOSE_FILE" up -d --build $SERVICES || fail "restart failed"
docker image prune -f >/dev/null 2>&1 || true

log "Health check"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    log "Healthy after ${i} attempt(s)"
    log "=== Deploy OK: $(git rev-parse --short HEAD) ==="
    exit 0
  fi
  sleep 2
done
fail "HEALTH CHECK FAILED after 60s — see BAMFORM-RUN-001 §6 (Rollback). No automatic rollback (ADR-012)."
