#!/usr/bin/env bash
# Generates the git-ignored secrets/ directory for local dev/test and CI
# (BUILD_HANDOFF non-negotiable #9: "dev/test: generated into git-ignored
# secrets/; never committed, never logged, never in env values").
#
# Mirrors the exact commands docs/DEPLOYMENT_RUNBOOK.md §3.1 uses for production key
# generation (openssl rand -base64 32 / openssl genpkey -algorithm ed25519), for every
# secret `docker-compose.yml`'s `bamform-api` service currently declares that the
# application actually reads (SecretFileLoader falls back to these files when no
# Docker secret mount is present at /run/secrets/<name>):
#   - jwt_signing_key.pem    — Ed25519 private key (PR-083 access tokens)
#   - blind_index_key        — HMAC-SHA-256 key (PR-108 email/employee_id lookup)
#   - kek                    — AES-256 Key Encryption Key (PR-107)
#   - dek_wrapped             — AES-256 Data Encryption Key, wrapped under the KEK
#                               (PR-106/107). The runbook does not show this generation
#                               command explicitly (only "openssl rand -base64 32 >
#                               secrets/kek" for the KEK itself) — wrapping is done here
#                               with the exact same AES-256-GCM primitive
#                               `api/src/crypto/key-wrapping.ts` uses, so this file
#                               unwraps with `unwrapDek(wrapped, kek)` exactly as
#                               production does.
#   - record_signing_key.pem — Ed25519 private key, DISTINCT from jwt_signing_key.pem
#                               (PR-SEC-07, PR-094)
#
# Idempotent — never regenerates a file that already exists (regenerating
# jwt_signing_key would invalidate every issued token; regenerating blind_index_key
# would break every existing login; regenerating kek/dek_wrapped would make every
# existing encrypted row undecryptable; regenerating record_signing_key would make
# every historical signature unverifiable — see DEPLOYMENT_RUNBOOK.md's
# troubleshooting table and SEC §6.1 "loss consequence" column).
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

mkdir -p secrets

if [ ! -f secrets/jwt_signing_key.pem ]; then
  echo "==> generating secrets/jwt_signing_key.pem (Ed25519, PR-083)"
  openssl genpkey -algorithm ed25519 -out secrets/jwt_signing_key.pem
fi

if [ ! -f secrets/record_signing_key.pem ]; then
  echo "==> generating secrets/record_signing_key.pem (Ed25519, PR-094, PR-SEC-07 — distinct from jwt_signing_key.pem)"
  openssl genpkey -algorithm ed25519 -out secrets/record_signing_key.pem
fi

if [ ! -f secrets/blind_index_key ]; then
  echo "==> generating secrets/blind_index_key (HMAC-SHA-256, login lookup, PR-108)"
  openssl rand -base64 32 > secrets/blind_index_key
fi

if [ ! -f secrets/kek ]; then
  echo "==> generating secrets/kek (AES-256 Key Encryption Key, PR-107)"
  openssl rand -base64 32 > secrets/kek
fi

if [ ! -f secrets/dek_wrapped ]; then
  echo "==> generating secrets/dek_wrapped (fresh AES-256 DEK, wrapped under the KEK, PR-106/107)"
  node -e '
    const { randomBytes, createCipheriv } = require("node:crypto");
    const { readFileSync, writeFileSync } = require("node:fs");
    const kek = Buffer.from(readFileSync("secrets/kek", "utf8").trim(), "base64");
    const dek = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const wrapped = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    writeFileSync("secrets/dek_wrapped", wrapped.toString("base64") + "\n");
  '
fi

chmod 600 secrets/jwt_signing_key.pem secrets/record_signing_key.pem secrets/blind_index_key \
  secrets/kek secrets/dek_wrapped 2>/dev/null || true
