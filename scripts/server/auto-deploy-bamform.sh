#!/usr/bin/env bash
# BamForm CD — server-side pull deploy. BAMFORM-RUN-001 §4.
# Install at /root/auto-deploy-bamform.sh, invoked by cron under flock:
#   * * * * * flock -n /tmp/bamform-deploy.lock /root/auto-deploy-bamform.sh >> /var/log/bamform-deploy.log 2>&1
#
# That install is a ONE-TIME bootstrap. From then on the script keeps its own
# installed copy in step with the repo after each green deploy — see
# sync_installed_copy() below for why it drifted and why the sync is at the end.
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

# The deployed build MUST be identifiable (slice 22-SELFUPDATE, review S-1).
#
# `.env` is sourced above with `set -a`, and it ships `IMAGE_TAG=local`. That
# exported constant reached `docker-compose.yml`'s
# `VITE_APP_VERSION: ${IMAGE_TAG:-local}` on every deploy, so every image was
# built and tagged identically no matter what was in it. The web client's
# self-update mechanism was the visible casualty — it compares `/sw.js` bytes
# and they never changed — but tagging every image `bamform-web:local` also
# means `docker images` cannot tell you what is running, and a rollback has
# nothing to roll back to.
#
# The script is standing in the checked-out commit; it knows the answer.
IMAGE_TAG=$(git rev-parse --short HEAD) || fail "cannot resolve deployed commit for IMAGE_TAG"
[ -n "$IMAGE_TAG" ] && [ "$IMAGE_TAG" != "local" ] \
  || fail "refusing to deploy with the placeholder IMAGE_TAG — images would be indistinguishable"
export IMAGE_TAG
log "Building as IMAGE_TAG=$IMAGE_TAG"
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

# Keep the INSTALLED copy in step with the repo (slice 22-SELFUPDATE follow-up).
#
# Cron runs /root/auto-deploy-bamform.sh — a manual copy of this file, taken
# once at install time. Nothing ever re-copied it, so the two drifted: the
# IMAGE_TAG fix above sat in the repository for a full deploy cycle while the
# box kept running the version without it, and `docker images` kept showing
# `bamform-web:local`. Any edit to this script was silently inert in
# production, which makes the repo copy documentation rather than the thing
# that runs — the worst kind of drift, because it reads as deployed.
#
# Installed AFTER a green deploy, deliberately: this run keeps the logic it
# started with (a script must never be rewritten underneath a running bash,
# which reads it incrementally), and only a build+migrate+health-check that
# actually passed is allowed to promote a new deploy script. A change here
# therefore takes effect on the NEXT deploy, one cycle later.
sync_installed_copy() {
  local src=$REPO/scripts/server/auto-deploy-bamform.sh
  [ -f "$src" ] || return 0
  cmp -s "$src" "$0" && return 0
  # Never install something that cannot parse — that would break every
  # subsequent deploy with no way in but SSH.
  bash -n "$src" || { log "WARN: repo deploy script has a syntax error — keeping the installed copy"; return 0; }
  if install -m 0755 "$src" "$0"; then
    log "Installed deploy script updated from $(git rev-parse --short HEAD) — effective next run"
  else
    log "WARN: could not update the installed deploy script at $0"
  fi
}

log "Health check"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    log "Healthy after ${i} attempt(s)"
    sync_installed_copy
    log "=== Deploy OK: $(git rev-parse --short HEAD) ==="
    exit 0
  fi
  sleep 2
done
fail "HEALTH CHECK FAILED after 60s — see BAMFORM-RUN-001 §6 (Rollback). No automatic rollback (ADR-012)."
