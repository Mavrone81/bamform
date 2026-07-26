# Environment Requirements Document
## BamForm — Preventive Maintenance Record and Approval System

---

## Document Control

| Field | Value |
|---|---|
| Document title | Environment Requirements Document — BamForm |
| Document number | BAMFORM-ENV-001 |
| Revision | 0.1 |
| Status | **Draft — for client review. Sections 2.3, 5 and 6 provisional pending Phase 0 recon (OI-07).** |
| Date issued | 24 July 2026 |
| Prepared by | Lead Engineer, BamForm project |
| Approved by | _(to be completed)_ |
| Classification | Internal — **contains no secret values** |
| Parent documents | BAMFORM-PRD-001 Rev 0.2 · BAMFORM-DBD-001 Rev 0.1 |

### Revision History

| Revision | Date | Details of revision | Revised by | Approved by |
|---|---|---|---|---|
| 0.1 | 24 Jul 2026 | Initial draft | Lead Engineer | _(pending)_ |

**This document names every secret. It contains the value of none of them.**

---

## Table of Contents

1. Environments
2. Host Requirements
3. Service Inventory
4. Configuration Variable Catalogue
5. Port Allocation
6. Resource Sizing
7. Backup and Restore
8. Certificates and DNS
9. Logging and Monitoring
10. Dependency Versions
11. Environment Parity and Known Divergence

---

# 1. Environments

| Environment | Purpose | Hosted | Data | Who has access |
|---|---|---|---|---|
| **Local development** | Feature work | Developer workstation, Docker Compose | Synthetic seed data only. **No production data, ever.** | Engineer |
| **CI** | Automated pipeline | GitHub Actions ephemeral runners with service containers | Generated per run, destroyed after | Pipeline only |
| **Staging** | Pre-release verification, UAT, restore drills | **To be confirmed** — see §1.1 | Anonymised or synthetic | Engineer, client UAT participants |
| **Production** | Live service | The `165` server | Live records | Engineer (deploy), client admin |

## 1.1 Staging — open point

The master build prompt asks whether the target is staging or production; the client has
confirmed the `165` server but not whether a separate staging environment exists.

**PR-ENV-01** A staging environment is **required** before go-live, for three reasons that are
not negotiable in a records system:

1. UR-111 requires the restore procedure to be tested and evidenced before acceptance. A
   restore test cannot be run against production.
2. The migration gate (BAMFORM-DBD-001 §10.2) requires applying migrations to a copy of the
   previous schema.
3. UAT (AC-01 to AC-18) requires client users to exercise the workflow, including voiding and
   returning records, which must not happen in the live archive.

Staging may be a second Compose project on the same `165` host with its own volumes, network
and port range, provided the recon confirms capacity. This is the cheapest option and is
recommended. It is **not** a shared database with a flag.

---

# 2. Host Requirements

## 2.1 Production host — the `165` server

**Status: PROVISIONAL.** The following are the requirements BamForm places on the host. They
will be checked against the actual host during Phase 0 recon (OI-07), and this section
rewritten with measured values.

| Requirement | Minimum | Recommended | Notes |
|---|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS | Must be within vendor support |
| CPU | 2 vCPU available to BamForm | 4 vCPU | Shared host — this is headroom above existing applications |
| RAM | 4 GB available to BamForm | 8 GB | See §6 breakdown |
| Disk | 60 GB free | 120 GB free | Dominated by attachments (DBD §9.1) |
| Docker Engine | 24.0 | 27.x | |
| Docker Compose | v2.20 | v2.30+ | Compose V2 plugin syntax throughout |
| git | 2.34 | 2.43+ | Required by the CD mechanism |
| `flock` | any (util-linux) | | Required for deploy lock |
| Outbound HTTPS | to `github.com` | | For `git fetch` in the CD loop |
| SMTP relay | reachable | | For notification dispatch (UR-061 to UR-064) |
| Time sync | NTP active | | **Critical** — signature and audit timestamps are evidence |

**PR-ENV-02** NTP synchronisation on the production host is a hard requirement, not a
nicety. Every electronic signature (PR-093) and every audit chain entry (PR-097) carries a
timestamp that may be relied upon in an ISO audit. Clock drift undermines the evidentiary
value of the entire archive. The recon must confirm `timedatectl` reports a synchronised
clock, and monitoring must alert if it stops.

## 2.2 Client device requirements

| Device class | Requirement |
|---|---|
| Technician phone/tablet | iOS 16.4+ / Safari, or Android 10+ / Chrome 108+. Service worker and IndexedDB support required for offline capture (PR-014) |
| Storage on device | 100 MB free for cached jobs and queued records |
| Desktop | Any evergreen browser — Chrome, Edge, Firefox, Safari, current and previous major version |
| Screen | Functional from 375 px width (UR-079) |

**PR-ENV-03** Internet Explorer and legacy Edge are not supported. No polyfill path exists for
the offline requirement on those engines.

## 2.3 Network — PROVISIONAL

**PR-ENV-04** All BamForm containers bind to `127.0.0.1` only (PR-001). The reverse proxy is
the sole public listener.

**PR-ENV-05** Whether BamForm adds a virtual host to an existing proxy or deploys Caddy is
decided by the recon (PR-016). A second listener on :443 is prohibited (CN-01).

---

# 3. Service Inventory

| Compose service | Image | Restart | Healthcheck | Volumes |
|---|---|---|---|---|
| `bamform-web` | Built — nginx-alpine serving static Vite bundle | `unless-stopped` | `GET /healthz` → 200 | none |
| `bamform-api` | Built — node:22-alpine, non-root | `unless-stopped` | `GET /api/v1/health` → 200 | none |
| `bamform-worker` | Built — same image as api, different command | `unless-stopped` | Queue heartbeat key in Redis | none |
| `bamform-migrate` | Built — same image as api | `no` (one-shot) | exit code 0 | none |
| `bamform-postgres` | `postgres:16-alpine` (digest-pinned) | `unless-stopped` | `pg_isready` | `bamform_pgdata` |
| `bamform-redis` | `redis:7-alpine` (digest-pinned) | `unless-stopped` | `redis-cli ping` | `bamform_redisdata` |
| `bamform-minio` | `minio/minio` (digest-pinned) | `unless-stopped` | `GET /minio/health/live` | `bamform_miniodata` |

**PR-ENV-06** Every service name is prefixed `bamform-` (PR-006) so no deploy command on the
shared host can address another application's service.

**PR-ENV-07** Named volumes are `bamform_pgdata`, `bamform_redisdata`, `bamform_miniodata`.
These are **never** removed by any automated process. `docker compose down -v` and
`docker volume rm` are prohibited in every script and runbook procedure.

---

# 4. Configuration Variable Catalogue

Every variable the system reads. `Secret = Y` means the value must never appear in git, in a
log, in an image layer, in a chat transcript, or in this document.

Provision: variables marked **`docker secret`** are supplied as Docker secrets (file-mounted).
All others come from a server-managed `.env` file referenced by `env_file:`, git-ignored, with
a committed `.env.example` documenting every key with a placeholder.

## 4.1 Core application

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `NODE_ENV` | enum | `production` | Y | N | `development` \| `test` \| `production` |
| `APP_ENV` | enum | — | Y | N | `local` \| `ci` \| `staging` \| `production`. Drives feature guards and log verbosity |
| `APP_BASE_URL` | url | — | Y | N | `https://form.bevorasg.com` — used in notification links |
| `API_PORT` | int | `3000` | N | N | Container-internal only |
| `LOG_LEVEL` | enum | `info` | N | N | `debug` \| `info` \| `warn` \| `error` |
| `TZ_DISPLAY` | string | `Asia/Kuala_Lumpur` | Y | N | Presentation timezone. Storage is always UTC (DBD DP-8) |
| `TRUST_PROXY_HOPS` | int | `1` | Y | N | Must match the proxy chain or client IP in the audit trail is wrong |

## 4.2 Database

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `DATABASE_URL` | url | — | Y | **Y** | Connection string for `bamform_app` role |
| `DATABASE_MIGRATE_URL` | url | — | Y | **Y** | Connection string for `bamform_migrate` role. Used only by the `migrate` service |
| `DATABASE_READONLY_URL` | url | — | N | **Y** | `bamform_readonly` role, used by reporting |
| `DATABASE_POOL_MAX` | int | `10` | N | N | Per api instance |
| `DATABASE_STATEMENT_TIMEOUT_MS` | int | `15000` | N | N | Guards against runaway report queries |
| `POSTGRES_PASSWORD` | string | — | Y | **Y** (`docker secret`) | Consumed by the postgres container |

## 4.3 Redis

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `REDIS_URL` | url | — | Y | **Y** | Includes credential |
| `REDIS_PASSWORD` | string | — | Y | **Y** (`docker secret`) | |
| `QUEUE_PREFIX` | string | `bull` | N | N | Namespacing on a shared Redis (not applicable here — Redis is dedicated) |

## 4.4 Object storage

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `MINIO_ENDPOINT` | host | `bamform-minio:9000` | Y | N | Internal only |
| `MINIO_ACCESS_KEY` | string | — | Y | **Y** (`docker secret`) | |
| `MINIO_SECRET_KEY` | string | — | Y | **Y** (`docker secret`) | |
| `MINIO_BUCKET` | string | `bamform-attachments` | Y | N | |
| `MINIO_SSE_KEY` | base64 | — | Y | **Y** (`docker secret`) | SSE-S3 key (PR-010) |
| `ATTACHMENT_MAX_BYTES` | int | `10485760` | N | N | 10 MB per photo |
| `ATTACHMENT_MAX_PER_JOB` | int | `30` | N | N | Bounds storage growth |
| `ATTACHMENT_ALLOWED_TYPES` | csv | `image/jpeg,image/png,image/webp` | N | N | Enforced by magic-byte inspection, not extension |

## 4.5 Cryptography and tokens

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `KEK` | base64 (32 B) | — | Y | **Y** (`docker secret`) | Key Encryption Key wrapping the DEK (PR-107). **Backed up separately from the database (PR-DBD-12)** |
| `DEK_WRAPPED` | base64 | — | Y | **Y** (`docker secret`) | The wrapped Data Encryption Key |
| `DEK_VERSION` | int | `1` | Y | N | Current DEK generation; matches `app_user.dek_version` |
| `BLIND_INDEX_KEY` | base64 (32 B) | — | Y | **Y** (`docker secret`) | HMAC-SHA-256 key for `email_bidx`. **Must differ from the DEK** (PR-108) |
| `JWT_SIGNING_KEY_CURRENT` | PEM | — | Y | **Y** (`docker secret`) | Ed25519 private key |
| `JWT_SIGNING_KEY_PREVIOUS` | PEM | — | N | **Y** (`docker secret`) | Retained during the 30-day rotation overlap (PR-087) |
| `JWT_KID_CURRENT` | string | — | Y | N | Key ID published in JWKS |
| `JWT_ISSUER` | string | `https://form.bevorasg.com` | Y | N | |
| `JWT_AUDIENCE` | string | `bamform-api` | Y | N | |
| `ACCESS_TOKEN_TTL_SECONDS` | int | `900` | N | N | 15 minutes (PR-083) |
| `REFRESH_TOKEN_TTL_DAYS` | int | `30` | N | N | |
| `RECORD_SIGNING_KEY` | PEM | — | Y | **Y** (`docker secret`) | Ed25519 key signing record content hashes (PR-094). **Distinct from the JWT key** |
| `RECORD_SIGNING_KID` | string | — | Y | N | Stored on each `approval_step` for later verification |
| `ARGON2_MEMORY_KIB` | int | `65536` | N | N | 64 MiB (PR-102) |
| `ARGON2_ITERATIONS` | int | `3` | N | N | |
| `ARGON2_PARALLELISM` | int | `4` | N | N | |
| `STEP_UP_WINDOW_SECONDS` | int | `900` | N | N | Re-authentication window for signing (PR-091) |

**PR-ENV-08** `RECORD_SIGNING_KEY` is deliberately separate from `JWT_SIGNING_KEY_CURRENT`.
A compromised session-token key must not confer the ability to forge historical approvals.

## 4.6 Authentication policy

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `LOGIN_MAX_ATTEMPTS` | int | `5` | N | N | Before lockout (UR-096) |
| `LOGIN_LOCKOUT_SECONDS` | int | `900` | N | N | Base; exponential backoff applied |
| `RATE_LIMIT_LOGIN_PER_MIN` | int | `10` | N | N | Per IP |
| `RATE_LIMIT_API_PER_MIN` | int | `300` | N | N | Per authenticated user |
| `SESSION_IDLE_TIMEOUT_MINUTES` | int | `60` | N | N | UR-097 |
| `PASSWORD_MIN_LENGTH` | int | `12` | N | N | |
| `RATE_LIMIT_STEP_UP_PER_MIN` | int | `10` | N | N | Per user (PR-091/PR-092) |

### 4.6.1 Multi-factor auth and forced password change (slice 13-MFA)

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `MFA_ENABLED` | bool | **`false`** | N | N | **Master switch for ALL MFA enforcement. MUST stay `false` until slice 13-UI is deployed** — see PR-ENV-27 |
| `MFA_REQUIRED_ROLES` | CSV | `ADMIN,TEAM_LEADER,ENGINEER,DOC_CONTROLLER,AUDITOR` | N | N | `MAINTAINER` deliberately absent (SEC §14 RS-3/SO-3) |
| `MFA_TOTP_ISSUER` | string | `BamForm` | N | N | Shown in the authenticator app |
| `MFA_CHALLENGE_TTL_SECONDS` | int | `300` | N | N | Life of the post-password login challenge token |
| `RATE_LIMIT_MFA_VERIFY_PER_MIN` | int | `10` | N | N | Per user; also `/auth/mfa/enrol/confirm` |
| `RATE_LIMIT_MFA_ENROL_PER_MIN` | int | `10` | N | N | Per user (`POST /auth/mfa/enrol`) |
| `RATE_LIMIT_MFA_RECOVERY_PER_MIN` | int | `5` | N | N | Per user |
| `RATE_LIMIT_PASSWORD_CHANGE_PER_MIN` | int | `10` | N | N | Per user (`POST /auth/password`) |
| `FORCE_PASSWORD_CHANGE_ENABLED` | bool | **`false`** | N | N | Whether `POST /users` marks the new account `must_change_password`. **MUST stay `false` until slice 13-UI is deployed** — see PR-ENV-27 |

**PR-ENV-27** `MFA_ENABLED` and `FORCE_PASSWORD_CHANGE_ENABLED` are **deployment-ordering master
switches**, not feature preferences. Both gate behaviour whose *user interface* ships in a later
slice (13-UI): MFA enforcement needs a screen that can collect a TOTP code, and the forced
password change needs a screen that can collect a new password. Turning either on before that
screen exists locks users — including the sole production ADMIN — out of
`form.bevorasg.com` with no in-product way back.

Both are parsed by the same strict helper (`api/src/common/env-flag.ts`): **only the literal
`"true"`, in any case, enables**. Absent, `""`, `"0"`, `"1"`, `"yes"`, `"on"` are all OFF, so a
typo or a half-written line fails safe. Neither may appear as `true` in committed configuration;
flipping them is a deliberate manual step after 13-UI is deployed and verified.

## 4.7 Scheduling and notification

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `SCHEDULER_ENABLED` | bool | `true` | Y | N | **`false` in every environment except production and staging** — prevents CI generating jobs |
| `SCHEDULER_CRON` | cron | `0 * * * *` | N | N | Hourly sweep (PR-050) |
| `SCHEDULER_LOCK_TTL_SECONDS` | int | `300` | N | N | PR-051 |
| `AUDIT_CHAIN_VERIFY_CRON` | cron | `0 2 * * *` | N | N | Daily audit hash-chain verification (PR-099); gated by `SCHEDULER_ENABLED` like the job-generation sweep (slice 8) |
| `DEFAULT_LEAD_TIME_DAYS` | int | `30` | N | N | PR-057; overridable per asset type |
| `DUE_SOON_WARNING_DAYS` | int | `7` | N | N | UR-062 |
| `VERIFICATION_ESCALATION_HOURS` | int | `72` | N | N | UR-050; overridable per approval stage |
| `SMTP_HOST` | host | — | Y | N | |
| `SMTP_PORT` | int | `587` | Y | N | |
| `SMTP_USER` | string | — | Y | **Y** | |
| `SMTP_PASSWORD` | string | — | Y | **Y** (`docker secret`) | |
| `SMTP_FROM` | email | — | Y | N | e.g. `bamform@bevorasg.com` |
| `NOTIFICATION_ENABLED` | bool | `true` | Y | N | **`false` in CI and local** — prevents test runs emailing real staff |

**PR-ENV-09** `SCHEDULER_ENABLED` and `NOTIFICATION_ENABLED` default to `false` in the
`.env.example` shipped for local development. A developer who copies the example and runs the
stack must not generate jobs or send email to production users.

## 4.8 Frontend build-time variables

Injected at build, not runtime. These are **public** — they ship in the browser bundle.

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `VITE_API_BASE_URL` | url | `/api/v1` | Y | N | Same-origin by default |
| `VITE_APP_VERSION` | string | commit SHA | Y | N | Displayed in the UI; used for service worker cache versioning (PR-068) |
| `VITE_OFFLINE_HISTORY_DAYS` | int | `90` | N | N | PR-069 |
| `VITE_SENTRY_DSN` | url | — | N | N | Optional; error reporting. **Public by design — DSNs are not secrets, but see PR-ENV-10** |

**PR-ENV-10** No variable prefixed `VITE_` may ever hold a secret. A CI check shall fail the
build if a `VITE_`-prefixed variable matches known secret patterns.

## 4.9 Deployment

| Variable | Type | Default | Required | Secret | Description |
|---|---|---|---|---|---|
| `COMPOSE_PROJECT_NAME` | string | `bamform` | Y | N | Isolates the Compose project on a shared host |
| `COMPOSE_FILE` | path | `/opt/bamform/docker-compose.yml` | Y | N | Provisional — path confirmed at recon |
| `DEPLOY_HEALTHCHECK_URL` | url | `http://127.0.0.1:{port}/api/v1/health` | Y | N | Post-deploy verification |
| `DEPLOY_LOG` | path | `/var/log/bamform-deploy.log` | Y | N | |
| `DEPLOY_BACKUP_DIR` | path | `/var/backups/bamform` | Y | N | Pre-migration dumps (PR-DBD-08) |

---

# 5. Port Allocation — PROVISIONAL

**This table cannot be completed until Phase 0 recon runs (OI-07).**

The recon will produce the required `port → process → container → application owner` table for
the whole host. BamForm's proposed allocation will then be stated and proven collision-free.

| Service | Proposed host binding | Public? |
|---|---|---|
| `bamform-web` | `127.0.0.1:{TBC}` | No — proxied |
| `bamform-api` | `127.0.0.1:{TBC}` | No — proxied |
| `bamform-postgres` | **none** | No — `data` network only |
| `bamform-redis` | **none** | No — `data` network only |
| `bamform-minio` | **none** | No — `data` network only |

**PR-ENV-11** Postgres, Redis and MinIO publish no host port under any circumstance, in any
environment including local development. Access for debugging is via `docker compose exec`.

---

# 6. Resource Sizing — PROVISIONAL pending OI-02

Based on 100 named users, 50 concurrent, 200 assets, 1,500 records/year (PRD PR-120).

| Service | CPU limit | Memory limit | Memory reservation | Disk |
|---|---|---|---|---|
| `bamform-web` | 0.25 | 128 MB | 32 MB | — (static files in image) |
| `bamform-api` | 1.0 | 768 MB | 256 MB | — |
| `bamform-worker` | 0.5 | 512 MB | 128 MB | — |
| `bamform-postgres` | 1.0 | 1 GB | 512 MB | 10 GB volume (7-yr projection < 1 GB, DBD §9.1) |
| `bamform-redis` | 0.25 | 256 MB | 64 MB | 1 GB volume |
| `bamform-minio` | 0.5 | 512 MB | 128 MB | **60 GB volume** — dominant consumer |
| **Total** | **3.5 vCPU** | **~3.2 GB** | **~1.1 GB** | **~71 GB** |

**PR-ENV-12** Memory *limits* shall be set on every service. On a shared host, an unbounded
container that leaks memory takes down unrelated applications. This directly mitigates RK-08.

**PR-ENV-13** PDF rendering (PR-117) spawns headless Chromium, which is memory-spiky. It shall
run in the `worker` service, not `api`, and shall be concurrency-limited to 2, so that a bulk
export cannot exhaust the host.

**PR-ENV-14** Sizing shall be restated once OI-02 is answered. The figure most sensitive to
machine count is MinIO volume: attachments scale linearly with records.

---

# 7. Backup and Restore

## 7.1 What must be backed up

| Item | Method | Frequency | Retention | Holds |
|---|---|---|---|---|
| Postgres | `pg_dump --format=custom` + WAL archiving | Nightly full, continuous WAL | 30 daily, 12 monthly, 7 yearly | All records, templates, audit chain |
| MinIO | `mc mirror` to backup path | Nightly | 30 daily, 12 monthly | Attachment objects |
| `.env` | Manual, on change | On change | Last 5 versions | Non-secret configuration |
| Docker secrets (KEK, DEK, signing keys) | **Manual, separate custody** | On rotation | All generations | **Without these, backups are unreadable** |
| Compose files, Dockerfiles | git | Every commit | Indefinite | — |

**PR-ENV-15** Key material is backed up **separately from the data**, held under a different
access control, and is never included in the same archive as a database dump. An attacker who
obtains one backup artefact must not thereby obtain both the ciphertext and the key.

**PR-ENV-16** Every DEK generation is retained indefinitely. Rows encrypted under
`dek_version = 1` remain readable after rotation to version 2 only if version 1 is still
available (DBD §6.2).

## 7.2 RPO and RTO

| Target | Requirement | Design |
|---|---|---|
| RPO | ≤ 24 hours (UR-110) | Nightly dump gives 24 h worst case; WAL archiving reduces actual exposure to minutes |
| RTO | ≤ 4 hours (UR-110) | Documented restore procedure, rehearsed, target 90 minutes |

## 7.3 Restore procedure

Full step-by-step in BAMFORM-RUN-001 §8. The design-level sequence:

1. Provision a clean host or scratch Compose project. **Never restore over a running production instance as the first action.**
2. Restore Docker secrets from key custody. Confirm `DEK_VERSION` matches the backup era.
3. Restore Postgres from the dump, then replay WAL to the target point in time.
4. Restore MinIO objects for the same point in time.
5. Start `bamform-api` in a read-only verification mode.
6. **Run the verification battery** in §7.4.
7. Only then cut over.

## 7.4 Restore verification battery — required before acceptance (UR-111, AC-14)

A restore is not proven by the containers starting. The following must pass:

| # | Check | Proves |
|---|---|---|
| RV-1 | Row counts match the source for `job`, `item_result`, `measurement_result`, `approval_step`, `audit_event` | Nothing lost |
| RV-2 | **Decrypt a known `app_user` row and match the expected name** | The KEK/DEK restored correctly (RK-12, AC-15) |
| RV-3 | Blind-index lookup on a known email returns the right user | `BLIND_INDEX_KEY` restored correctly |
| RV-4 | **Audit chain verification passes end to end** | Chain integrity survived backup and restore (PR-DBD-14) |
| RV-5 | `GET /records/{id}/integrity` returns pass for 10 sampled archived records | Signatures verify; content unchanged |
| RV-6 | Every `attachment.sha256` matches the restored object | Object storage and database restored to the same point |
| RV-7 | Render a sampled record to PDF and compare to a pre-backup copy | End-to-end read path functional |

**PR-ENV-17** RV-2, RV-4 and RV-5 are the checks that distinguish a real restore test from a
theatrical one. A restore that produces correct row counts but unreadable personal data or a
broken audit chain has restored nothing of evidentiary value.

---

# 8. Certificates and DNS

| Item | Requirement | Owner |
|---|---|---|
| DNS `form.bevorasg.com` | A/AAAA record to the `165` server public address | Client (DP-02) |
| TLS certificate | Automatic ACME issuance and renewal | Caddy, **or** the existing proxy's mechanism — decided at recon |
| TLS version | 1.3 only. 1.2 permitted only with written client approval | — |
| HSTS | `max-age=31536000; includeSubDomains` after a successful soak period | — |
| OCSP stapling | Enabled | — |

**PR-ENV-18** HSTS shall not be enabled with a long `max-age` until the certificate renewal
path has been observed to work at least once. Enabling it prematurely on a misconfigured host
makes the service unreachable and un-fixable from the client side for the duration of the
policy.

**PR-ENV-19** Certificate expiry shall be monitored with an alert at 21 days remaining. A
failed renewal on an internal tool is discovered by users, not by anyone watching, unless it
is monitored.

---

# 9. Logging and Monitoring

## 9.1 Log destinations

| Source | Destination | Rotation | Retention |
|---|---|---|---|
| Container stdout/stderr | Docker `json-file` driver, `max-size=10m`, `max-file=5` | Driver-managed | ~50 MB per service |
| Deploy script | `/var/log/bamform-deploy.log` | logrotate, daily, 30 days, compressed | 30 days |
| Proxy access/error | Proxy's own location — confirmed at recon | Existing host policy | Existing host policy |
| Application audit trail | **`audit_event` table — not a log file** | Never rotated | 7 years (UR-107) |

**PR-ENV-20** The audit trail is a database table, not a log. Log rotation must never be
capable of destroying audit evidence. This separation is deliberate.

## 9.2 What must never appear in a log

**PR-ENV-21** The logger shall redact, at the serialiser level, so redaction cannot be
forgotten at a call site:

- Passwords, in any field name matching `password`, `passwd`, `secret`, `token`, `key`
- Full JWTs and refresh tokens
- Decrypted personal data — names, emails, employee IDs
- KEK, DEK, blind index key, signing keys
- Full request bodies on auth endpoints

**PR-ENV-22** A CI test shall assert that a login request with a known password produces no log
line containing that password.

## 9.3 Monitoring signals

| Signal | Threshold | Why |
|---|---|---|
| `api` healthcheck failing | 2 consecutive | Service down |
| Postgres connections | > 80 % of pool | Saturation before outage |
| Disk free on volume mount | < 20 % | MinIO growth; deploy needs headroom |
| Queued notifications not draining | > 100 for 15 min | Worker or SMTP failure |
| Scheduler last-run age | > 2 h | Jobs not being generated — silent compliance failure |
| **Audit chain verification** | any failure | Tamper or corruption — highest severity |
| Certificate expiry | < 21 days | §8 |
| Clock offset | > 2 s | PR-ENV-02 |
| Failed logins | > 50 in 10 min | Credential attack |

**PR-ENV-23** "Scheduler last-run age" is the most important operational signal in the system.
Every other failure is visible to users; a stopped scheduler produces silence — no jobs, no
complaints, and a compliance gap discovered at the next audit.

---

# 10. Dependency Versions

Pinned. Upgrades are deliberate, tested, and go through the pipeline.

| Component | Version | Pinning |
|---|---|---|
| Node.js | 22 LTS | Base image by digest |
| PostgreSQL | 16.x | Image by digest |
| Redis | 7.x | Image by digest |
| MinIO | current stable | Image by digest |
| NestJS | 11.x | `package-lock.json` |
| React | 19.x | `package-lock.json` |
| Vite | 6.x | `package-lock.json` |
| Tailwind | 4.x | `package-lock.json` |
| Prisma | 6.x | `package-lock.json` |
| Playwright | current | `package-lock.json`, browser version pinned in CI |

**PR-ENV-24** Base images are pinned by **digest**, not tag (PR-004). `postgres:16-alpine` is a
moving target; `postgres@sha256:…` is reproducible. Dependabot raises digest updates as pull
requests, which go through the full pipeline like any other change.

---

# 11. Environment Parity and Known Divergence

Parity is a goal, not a fiction. The divergences below are deliberate and documented.

| Aspect | Production | Staging | CI | Local | Justified because |
|---|---|---|---|---|---|
| TLS | Real cert | Real or self-signed | None (in-cluster) | None | CI has no public listener |
| `SCHEDULER_ENABLED` | `true` | `true` | `false` | `false` | Prevents test runs generating jobs |
| `NOTIFICATION_ENABLED` | `true` | `true` (to a test mailbox) | `false` | `false` | Prevents emailing real staff |
| Data | Live | Anonymised/synthetic | Generated | Synthetic seed | **No production data leaves production** |
| Secrets | Docker secrets | Docker secrets, different values | Generated per run | `.env` from `.env.example` | |
| Resource limits | Enforced (§6) | Enforced, smaller | Runner defaults | None | |
| Log level | `info` | `debug` | `debug` | `debug` | |
| Object storage | MinIO volume | MinIO volume | MinIO service container | MinIO container | |

**PR-ENV-25** Production data shall never be copied to any other environment. Where realistic
data is needed for UAT, it shall be generated or anonymised — personal columns replaced,
`audit_event` chain regenerated. A copy of the live archive on a developer laptop is a PDPA
incident (UR-100).

**PR-ENV-26** The `.env.example` file shall be committed, shall document every key in §4, and
shall contain placeholder values only. CI shall fail if a key exists in the application's
configuration schema but is absent from `.env.example` — this is the mechanism that stops this
document going stale.

---

*End of document — BAMFORM-ENV-001 Revision 0.1*
