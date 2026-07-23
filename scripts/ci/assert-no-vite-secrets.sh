#!/usr/bin/env bash
# PR-ENV-10: VITE_ variables ship in the browser bundle. None may hold a secret.
set -euo pipefail
violations=$(grep -rEn 'VITE_[A-Z_]*(SECRET|KEY|PASSWORD|TOKEN|CREDENTIAL|PRIVATE)' \
  --include='*.ts' --include='*.tsx' --include='*.env*' --include='*.yml' \
  --exclude-dir=node_modules --exclude-dir=dist . \
  | grep -v 'assert-no-vite-secrets' || true)
if [ -n "$violations" ]; then
  echo "FAIL: VITE_-prefixed variable matches a secret pattern:"; echo "$violations"; exit 1
fi
echo "PASS: no VITE_ variable holds a secret"
