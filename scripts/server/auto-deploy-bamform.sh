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

# ------------------------------------------------------------------ self-heal
#
# A deploy that dies at the restart step leaves ZERO containers running:
# `docker compose up -d` stops the old ones before it starts the new ones, so
# a failure between the two is a total outage, and ADR-012's "no automatic
# rollback, the previous version keeps serving" does not apply — there is no
# previous version serving.
#
# Worse, `git reset --hard` has ALREADY advanced HEAD by that point. The next
# tick sees LOCAL = REMOTE, decides there is nothing to deploy, and exits. No
# later tick has any reason to act, so production stays down indefinitely with
# the cron running happily every minute.
#
# That is not hypothetical: 2026-07-29, `ERROR: restart failed` at 04:02, and
# form.bevorasg.com served 502 for four hours because every subsequent tick
# took the up-to-date early exit. Recovery was one `docker compose start`.
#
# So availability is checked INDEPENDENTLY of whether there is anything new to
# deploy. This is the difference between a one-minute blip and a four-hour
# outage.
service_running() {
  local cid
  cid=$(docker compose -f "$COMPOSE_FILE" ps -aq "$1" 2>/dev/null | head -1)
  [ -n "$cid" ] || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]
}

stopped_services() {
  local svc missing=""
  for svc in $SERVICES; do
    service_running "$svc" || missing="$missing $svc"
  done
  printf '%s' "${missing# }"
}

self_heal() {
  log "SELF-HEAL: not running: $1 — restoring the deployed build"
  IMAGE_TAG=$(git rev-parse --short HEAD); export IMAGE_TAG
  # --no-build first: the images for this commit are almost certainly already
  # on disk (they are SHA-tagged since slice 22), and rebuilding during an
  # outage adds minutes for nothing.
  if ! docker compose -f "$COMPOSE_FILE" up -d --no-build $SERVICES; then
    log "SELF-HEAL: no image for $IMAGE_TAG — rebuilding"
    docker compose -f "$COMPOSE_FILE" up -d --build $SERVICES \
      || { log "ERROR: SELF-HEAL FAILED — production is DOWN and needs a human"; return 1; }
  fi
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "=== SELF-HEAL OK: healthy after ${i} attempt(s) at $(git rev-parse --short HEAD) ==="
      return 0
    fi
    sleep 2
  done
  log "ERROR: SELF-HEAL started containers but the health check FAILED — needs a human"
  return 1
}

cd "$REPO" || fail "repo not found at $REPO"
git fetch origin main --quiet || fail "git fetch failed"

LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  DOWN=$(stopped_services)
  if [ -n "$DOWN" ]; then
    self_heal "$DOWN" || exit 1
  fi
  exit 0
fi

log "=== Deploy start: ${LOCAL:0:7} -> ${REMOTE:0:7} ==="

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +'%Y%m%dT%H%M%SZ')
log "Pre-migration backup"
# The dump runs THROUGH the postgres container, so it needs that container up.
# When a previous deploy has left the stack down, aborting here makes the
# outage permanent: the safety check depends on the very thing the failure
# took away, and every retry dies at the same line. On 2026-07-29 that turned
# a failed restart into four hours of 502s.
#
# A stopped database has accepted no writes since it stopped, so there is
# nothing this dump would capture that the nightly encrypted archive does not
# already hold. Skipping is therefore safe HERE and only here — if postgres is
# UP and the dump fails, that is a real failure and still aborts the deploy.
if service_running bamform-postgres; then
  docker compose -f "$COMPOSE_FILE" exec -T bamform-postgres \
    pg_dump -U bamform_migrate --format=custom bamform \
    > "$BACKUP_DIR/predeploy-$STAMP.dump" || fail "pre-deploy backup failed — deploy aborted"
  find "$BACKUP_DIR" -name 'predeploy-*.dump' -mtime +7 -delete
else
  log "WARNING: postgres is not running — SKIPPING the pre-deploy backup so the stack can recover (nightly archive is the fallback)"
fi

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
