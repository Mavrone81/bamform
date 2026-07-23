#!/usr/bin/env bash
# Generates the git-ignored secrets/ directory for local dev/test and CI
# (BUILD_HANDOFF non-negotiable #9: "dev/test: generated into git-ignored
# secrets/; never committed, never logged, never in env values").
#
# Mirrors the exact commands docs/DEPLOYMENT_RUNBOOK.md uses for production
# key generation (openssl genpkey -algorithm ed25519 / openssl rand -base64
# 32), scoped for now to the two secrets slice 2's auth module actually
# reads (SecretFileLoader falls back to these files when no Docker secret
# mount is present at /run/secrets/<name>):
#   - jwt_signing_key.pem  — Ed25519 private key (PR-083 access tokens)
#   - blind_index_key      — HMAC-SHA-256 key (email login lookup only;
#                             see api/src/auth/crypto/blind-index.ts)
#
# Idempotent — never regenerates a file that already exists (regenerating
# jwt_signing_key would invalidate every issued token; regenerating
# blind_index_key would break every existing login, per
# DEPLOYMENT_RUNBOOK.md's troubleshooting table).
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

mkdir -p secrets

if [ ! -f secrets/jwt_signing_key.pem ]; then
  echo "==> generating secrets/jwt_signing_key.pem (Ed25519, PR-083)"
  openssl genpkey -algorithm ed25519 -out secrets/jwt_signing_key.pem
fi

if [ ! -f secrets/blind_index_key ]; then
  echo "==> generating secrets/blind_index_key (HMAC-SHA-256, login lookup)"
  openssl rand -base64 32 > secrets/blind_index_key
fi

chmod 600 secrets/jwt_signing_key.pem secrets/blind_index_key 2>/dev/null || true
