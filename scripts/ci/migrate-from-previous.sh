#!/usr/bin/env bash
# Migration check (b): apply current migrations on top of the previous release's schema.
set -euo pipefail
BASE_REF="${GITHUB_BASE_REF:-main}"
git rev-parse "origin/$BASE_REF" >/dev/null 2>&1 || { echo "SKIP: no base"; exit 0; }
WORK=$(mktemp -d)
git worktree add "$WORK" "origin/$BASE_REF" >/dev/null
psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
# Apply the PREVIOUS release's migrations, then the CURRENT ones on top.
# Run the repo's PINNED prisma (from this checkout's node_modules) against the
# worktree's schema — do NOT `cd "$WORK"`: that temp dir has no node_modules, so
# `npx prisma` there fetches prisma@latest, which rejects this project's
# `datasource url` syntax (P1012) and fails a check that has nothing to do with
# the migrations. --schema resolves the migrations dir next to it ($WORK/.../migrations).
npx prisma migrate deploy --schema="$WORK/api/prisma/schema.prisma"
npx prisma migrate deploy --schema=api/prisma/schema.prisma
git worktree remove "$WORK" --force
echo "PASS: current migrations apply on the previous schema"
