#!/usr/bin/env bash
# M-04 / PR-DBD-07: every migration documents its reversal in a header comment.
set -euo pipefail
fail=0
for f in api/prisma/migrations/*/migration.sql; do
  [ -e "$f" ] || { echo "SKIP: no migrations yet"; exit 0; }
  head -20 "$f" | grep -qiE '^-- *Reversal:' || { echo "MISSING reversal note: $f"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "PASS: all migrations document reversal" || exit 1
