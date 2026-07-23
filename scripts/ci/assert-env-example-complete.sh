#!/usr/bin/env bash
# PR-ENV-26: every key the application reads must be documented in .env.example.
# This is the mechanism that stops the ENV document going stale.
set -euo pipefail
missing=0
# Keys the code reads: process.env.X across api/ and worker source
used=$(grep -rhoE "process\.env\.[A-Z][A-Z0-9_]+" api/src shared/src 2>/dev/null \
  | sed 's/process\.env\.//' | sort -u || true)
for key in $used; do
  case "$key" in NODE_ENV|CI|GITHUB_*|HOME|PATH|PWD|TZ) continue;; esac
  if ! grep -qE "^${key}=" .env.example; then
    echo "MISSING from .env.example: $key"; missing=1
  fi
done
[ "$missing" -eq 0 ] && echo "PASS: .env.example documents every key" || exit 1
