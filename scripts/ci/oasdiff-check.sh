#!/usr/bin/env bash
# C-04: fail on an unannounced breaking change to the API contract.
set -euo pipefail
BASE_REF="${GITHUB_BASE_REF:-main}"
if ! git rev-parse "origin/$BASE_REF" >/dev/null 2>&1; then
  echo "SKIP: no base ref (first push)"; exit 0
fi
git show "origin/$BASE_REF:api/openapi.yaml" > /tmp/openapi-base.yaml 2>/dev/null || {
  echo "SKIP: contract absent on base"; exit 0; }
docker run --rm -v /tmp:/tmp -v "$PWD/api:/spec" tufin/oasdiff:latest \
  breaking /tmp/openapi-base.yaml /spec/openapi.yaml --fail-on ERR
echo "PASS: no unannounced breaking change"
