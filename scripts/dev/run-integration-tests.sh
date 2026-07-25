#!/usr/bin/env bash
# Local dev convenience — mirrors the "integration" job in
# .github/workflows/ci.yml (migrate deploy -> apply grants -> run tests)
# against the loopback-only Postgres in docker-compose.test.yml. CI does not
# use this script; it is not part of any CI job.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

export DATABASE_URL="postgresql://bamform:test_ephemeral_not_a_real_secret@localhost:15432/bamform_test?schema=public"
export REDIS_URL="redis://localhost:16379"
export MINIO_ENDPOINT="localhost:19000"
export MINIO_ROOT_USER="bamform"
export MINIO_BUCKET="bamform-attachments"

echo "==> generating dev secrets (JWT signing key, blind index key) if missing"
bash "$(dirname "${BASH_SOURCE[0]}")/generate-dev-secrets.sh"

echo "==> starting test Postgres + Redis + MinIO (docker-compose.test.yml)"
docker compose -f docker-compose.test.yml up -d --wait

echo "==> applying migrations"
npx prisma migrate deploy --schema=api/prisma/schema.prisma

echo "==> applying role grants (DBD §7.1)"
CID=$(docker compose -f docker-compose.test.yml ps -q bamform-test-postgres)
docker cp api/prisma/grants.sql "$CID":/tmp/grants.sql
docker exec -e PGPASSWORD=test_ephemeral_not_a_real_secret "$CID" \
  psql -U bamform -d bamform_test -v ON_ERROR_STOP=1 -f /tmp/grants.sql

echo "==> running I-INV-01..11 / S-06..S-09 / S-19 / S-30 / I-INV-19 integration suite"
npm run test:integration --workspace=api
