#!/usr/bin/env bash
# M-06: index creation on large tables must use CONCURRENTLY.
set -euo pipefail
LARGE_TABLES='audit_event|item_result|measurement_result|job'
fail=0
for f in api/prisma/migrations/*/migration.sql; do
  [ -e "$f" ] || { echo "SKIP: no migrations yet"; exit 0; }
  bad=$(grep -niE "CREATE (UNIQUE )?INDEX (?!CONCURRENTLY)" "$f" 2>/dev/null \
        | grep -E "$LARGE_TABLES" || true)
  # grep -P not portable; do it in two steps
  while IFS= read -r line; do
    echo "$line" | grep -qi CONCURRENTLY || { echo "NON-CONCURRENT index on large table in $f: $line"; fail=1; }
  done < <(grep -niE "CREATE (UNIQUE )?INDEX" "$f" | grep -E "$LARGE_TABLES" || true)
done
[ "$fail" -eq 0 ] && echo "PASS: large-table indexes are concurrent" || exit 1
