#!/usr/bin/env bash
# S-28 / PR-SEC-23: CSP must contain neither unsafe-inline nor unsafe-eval.
set -euo pipefail
if grep -rEn "unsafe-(inline|eval)" web/nginx.conf api/src 2>/dev/null; then
  echo "FAIL: CSP contains unsafe-inline or unsafe-eval"; exit 1
fi
echo "PASS: CSP is safe"
