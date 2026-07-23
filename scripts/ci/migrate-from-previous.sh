#!/usr/bin/env bash
# Migration check (b): apply current migrations on top of the previous release's schema.
set -euo pipefail
BASE_REF="${GITHUB_BASE_REF:-main}"
git rev-parse "origin/$BASE_REF" >/dev/null 2>&1 || { echo "SKIP: no base"; exit 0; }
WORK=$(mktemp -d)
git worktree add "$WORK" "origin/$BASE_REF" >/dev/null
psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
( cd "$WORK" && npx prisma migrate deploy --schema=api/prisma/schema.prisma )
npx prisma migrate deploy --schema=api/prisma/schema.prisma
git worktree remove "$WORK" --force
echo "PASS: current migrations apply on the previous schema"
