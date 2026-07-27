#!/usr/bin/env bash
# Nightly backup — BAMFORM-RUN-001 §8.1, rebuilt 2026-07-27 after the system
# review (SYS-3) found the original was never scheduled, its MinIO path never
# worked, and its "secrets are under separate custody" premise was false (the
# custody never existed — SYS-4/CR-1).
#
# Install at /root/bamform-backup.sh with:
#   30 1 * * * root /root/bamform-backup.sh >> /var/log/bamform-backup.log 2>&1
#
# What it produces: ONE encrypted archive per night at
#   /var/backups/bamform/bamform-<UTC-stamp>.tar.gz.enc   (chmod 600)
# containing:
#   db.dump        pg_dump --format=custom of the bamform database
#   miniodata.tar  the attachments volume (tar of /data via a helper container)
#   secrets.tar    /opt/bamform/secrets — the KEK, wrapped DEK, blind-index
#                  and signing keys. Deliberately INCLUDED as of 2026-07-27:
#                  the archive must be self-sufficient, so that the day it is
#                  copied off-box it restores a dead system on fresh hardware.
#   env            /opt/bamform/.env
#
# Encryption: AES-256-CBC via openssl enc, PBKDF2 (200k iters), key read from
# BACKUP_ENCRYPTION_KEY in /opt/bamform/.env.
#
# ── STAGING ARRANGEMENT — owner decision, Samuel 2026-07-27 ────────────────
# "Same 165 server, self-generated key, key in the .env as a sample, for
# staging purposes." That is what this implements. What it does and does not
# protect:
#   PROTECTS AGAINST: database corruption, a bad migration, accidental
#     deletion, an application bug destroying rows — restore from last night.
#   DOES NOT PROTECT AGAINST: loss of the droplet. The archives, the key
#     that decrypts them, and the live data share one disk.
#   Anyone who can read /opt/bamform/.env can decrypt the archives — on this
#     box that is root-only, the same trust domain as secrets/ itself.
# Before production go-live: move the archives OFF-BOX and move
# BACKUP_ENCRYPTION_KEY out of .env into real escrow. Ledger tracks this as
# the top go-live item.
# ───────────────────────────────────────────────────────────────────────────
#
# Restore (test-restored 2026-07-27, see ledger):
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
#     -pass env:BACKUP_ENCRYPTION_KEY -in bamform-<stamp>.tar.gz.enc | tar xz
#   pg_restore -U bamform_migrate -d <target-db> --clean --if-exists db.dump
#   untar miniodata.tar into the recreated volume; untar secrets.tar into
#   /opt/bamform/secrets; restore env; compose up.

set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=/opt/bamform
COMPOSE_FILE=$REPO/docker-compose.yml
BACKUP_DIR=/var/backups/bamform
STAMP=$(date -u +'%Y%m%dT%H%M%SZ')

log() { printf '%s  %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
WORK=$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap 'log "ERROR: backup failed at line $LINENO"; cleanup' ERR
trap cleanup EXIT

# Key comes from .env — do NOT source the whole file (it has previously
# contained lines that abort sourcing; the AdWebsite incident). Extract the
# single variable instead.
BACKUP_ENCRYPTION_KEY=$(grep -E '^BACKUP_ENCRYPTION_KEY=' "$REPO/.env" | head -1 | cut -d= -f2-)
if [ -z "$BACKUP_ENCRYPTION_KEY" ]; then
  log "FATAL: BACKUP_ENCRYPTION_KEY missing from $REPO/.env — refusing to write an unencrypted backup"
  exit 1
fi
export BACKUP_ENCRYPTION_KEY

log "Postgres dump"
docker compose -f "$COMPOSE_FILE" exec -T bamform-postgres \
  pg_dump -U bamform_migrate --format=custom bamform > "$WORK/db.dump"

log "MinIO volume (attachments)"
# Tar the volume through a throwaway container — works regardless of mc
# configuration and captures the whole bucket state.
docker run --rm --volumes-from bamform-minio alpine:3 tar cf - /data > "$WORK/miniodata.tar"

log "Secrets (key escrow inside the archive — see header)"
tar cf "$WORK/secrets.tar" -C "$REPO" secrets

log "Env"
cp "$REPO/.env" "$WORK/env"

log "Encrypt bundle"
tar czf - -C "$WORK" db.dump miniodata.tar secrets.tar env \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass env:BACKUP_ENCRYPTION_KEY \
      -out "$BACKUP_DIR/bamform-$STAMP.tar.gz.enc"
chmod 600 "$BACKUP_DIR/bamform-$STAMP.tar.gz.enc"

# Retention: 14 nightly archives (same-disk — more is false comfort).
find "$BACKUP_DIR" -maxdepth 1 -name 'bamform-*.tar.gz.enc' -mtime +14 -delete

# Tighten any legacy pre-deploy dumps left world-readable (crypto review).
find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name 'env-*' \) -exec chmod 600 {} + 2>/dev/null || true

# The check that stops silent failure (PR-RUN-14): tonight's archive must
# exist, be non-trivial, and DECRYPT — an unreadable backup is not a backup.
LATEST="$BACKUP_DIR/bamform-$STAMP.tar.gz.enc"
[ -s "$LATEST" ] || { log "FATAL: archive missing/empty"; exit 1; }
[ "$(stat -c%s "$LATEST")" -gt 10240 ] || { log "FATAL: archive suspiciously small"; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY \
  -in "$LATEST" | tar tz > /dev/null \
  || { log "FATAL: archive does not decrypt/list — key or pipeline broken"; exit 1; }

log "OK: $LATEST ($(stat -c%s "$LATEST") bytes, decrypt-verified)"
