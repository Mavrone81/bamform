# API Specification
## BamForm — Preventive Maintenance Record and Approval System

---

## Document Control

| Field | Value |
|---|---|
| Document title | API Specification — BamForm |
| Document number | BAMFORM-API-001 |
| Revision | 0.1 |
| Status | **Draft — for client review** |
| Date issued | 24 July 2026 |
| Prepared by | Lead Engineer, BamForm project |
| Approved by | _(to be completed)_ |
| Classification | Internal |
| Machine-readable contract | `/api/openapi.yaml` (OpenAPI 3.1) — committed, lint-checked in CI |
| Parent documents | BAMFORM-PRD-001 Rev 0.2 · BAMFORM-DBD-001 Rev 0.1 |

### Revision History

| Revision | Date | Details of revision | Revised by | Approved by |
|---|---|---|---|---|
| 0.1 | 24 Jul 2026 | Initial draft | Lead Engineer | _(pending)_ |

---

## Table of Contents

1. The Contract
2. Conventions
3. Authentication
4. Authorisation
5. Error Model
6. Pagination
7. Idempotency
8. Concurrency
9. Rate Limiting
10. Endpoint Reference
11. The Sync Protocol
12. Governance and CI Enforcement

---

# 1. The Contract

**PR-API-01** `api/openapi.yaml` is the contract, not this document. This document explains it.
Where the two disagree, the YAML is authoritative and this document is a defect.

**PR-API-02** The specification is OpenAPI **3.1**. It is committed to the repository, linted
with Spectral in CI, and validated against the running implementation by contract tests. A
build in which implementation and specification diverge **fails** (master prompt §5 stage 5).

**PR-API-03** Swagger UI is served at `/api/v1/docs`, behind authentication. It is not public.

---

# 2. Conventions

| Aspect | Convention |
|---|---|
| Base path | `/api/v1` — all endpoints versioned (PR-078) |
| Transport | HTTPS only. HTTP redirects to HTTPS at the proxy |
| Content type | `application/json; charset=utf-8`, except attachment upload (`multipart/form-data`) and PDF (`application/pdf`) |
| Casing | `camelCase` in JSON bodies; `kebab-case` in path segments |
| Identifiers | UUIDv7 strings. Clients may generate them (offline capture) |
| Dates | RFC 3339 with offset. **Instants are always UTC (`Z`)**; calendar dates are `YYYY-MM-DD` with no time |
| Booleans | True JSON booleans. Never `"true"`, never `0`/`1` |
| Numbers | Measurement readings are JSON numbers with up to 6 decimal places. Never strings |
| Empty vs absent | `null` means "explicitly no value". An absent key in a `PATCH` means "leave unchanged" |
| Enumerations | Uppercase snake — `IN_PROGRESS`, `NOT_APPLICABLE` |
| Correlation | Every response carries `X-Request-Id`, echoed into `audit_event.request_id` |

**PR-API-04** Verbs are HTTP verbs, not path segments — with one deliberate exception. Workflow
transitions (`/submit`, `/verify`, `/return`, `/recall`, `/void`) are modelled as `POST` to a
sub-resource rather than as a `PATCH` of a status field. A state transition is not a field
edit: it has preconditions, side effects, its own authorisation, and it produces a signature.
Modelling it as `PATCH {status: "VERIFIED"}` would invite clients to treat it as data.

---

# 3. Authentication

**PR-API-05** `Authorization: Bearer <access token>` on every endpoint except `/auth/login`,
`/auth/refresh`, `/health` and `/.well-known/jwks.json`.

| Endpoint | Behaviour |
|---|---|
| `POST /auth/login` | Body `{ email, password }`. Returns access token in body; refresh token in `HttpOnly; Secure; SameSite=Strict` cookie (PR-085). Rate-limited, lockout after 5 failures. **When MFA applies** (see §3.2) it returns an `MfaChallenge` instead, with no token and no cookie |
| `POST /auth/refresh` | Reads the refresh cookie. Rotates: old token invalidated, new pair issued. **Reuse of a spent token revokes the entire family** and raises a security audit event (PR-084) |
| `POST /auth/logout` | Revokes the refresh family; adds the current `jti` to the Redis denylist |
| `POST /auth/step-up` | Body `{ password }`. Refreshes `last_authenticated_at`. **Required before signing** if the step-up window has lapsed (PR-091). **Password-only** — TOTP is deliberately not required here (§3.2) |
| `POST /auth/password` | Body `{ currentPassword, newPassword }`. Own account only. Clears `must_change_password`, stamps `password_changed_at`, revokes every OTHER refresh-token family. Audited `password_changed` |
| `POST /auth/mfa/enrol` | Issues a TOTP secret (base32 + `otpauth://` URI). Authorised by an access token or an MFA `challengeToken`. 409 if already enrolled |
| `POST /auth/mfa/enrol/confirm` | Body `{ totpCode }`. Confirms enrolment and returns the ten recovery codes **once**. Completes the login when called with a `challengeToken` |
| `POST /auth/mfa/verify` | Body `{ challengeToken, totpCode }`. Second step of login; issues the access token and refresh cookie |
| `POST /auth/mfa/recovery` | Body `{ challengeToken, recoveryCode }`. Redeems a single-use recovery code. Audited `mfa_recovery_code_used` |
| `GET /.well-known/jwks.json` | Public. Publishes Ed25519 verification keys with `kid` (PR-087) |

**PR-API-06** Access tokens are held in memory by the client, never in `localStorage`. The
offline client holds the refresh cookie and re-acquires an access token on reconnection; it
does not need a valid access token to *capture* a record, only to transmit one.

## 3.1 Step-up on signing

**PR-API-07** `POST /jobs/{id}/verify` and `POST /revisions/{id}/approve` return
**`403` with `type: /errors/step-up-required`** if `last_authenticated_at` is older than
`STEP_UP_WINDOW_SECONDS`. The client presents a password prompt, calls `/auth/step-up`, and
retries. This is what makes a signature attributable to a person rather than to a browser left
open on a shop-floor terminal.

## 3.2 Multi-factor authentication at login

**PR-API-07a** MFA is TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s, plus/minus one step), challenged
**at login** as a second step after the password — never as part of step-up-before-signing, which
stays password-only. See BAMFORM-SEC-001 §5.1 for the cryptographic detail and §14 RS-3 for why
`MAINTAINER` is exempt.

It applies to a user holding **any** role in `MFA_REQUIRED_ROLES` (default `ADMIN`,
`TEAM_LEADER`, `ENGINEER`, `DOC_CONTROLLER`, `AUDITOR`) and is gated by the master switch
`MFA_ENABLED`, which **defaults to `false`**. With the switch off, `/auth/login` behaves exactly
as §3 describes it without this section; the enrolment endpoints still work, so a user may enrol
ahead of time.

When it applies, `POST /auth/login` returns `200` with

```json
{ "mfaRequired": true, "mfaEnrolled": true, "challengeToken": "…", "expiresIn": 300 }
```

and **no access token and no refresh cookie**. The `challengeToken` is a 5-minute, single-use,
EdDSA-signed JWT with its own audience (`bamform-mfa-challenge`) and `typ`
(`mfa-challenge+jwt`). It authorises only `/auth/mfa/verify`, `/auth/mfa/recovery`,
`/auth/mfa/enrol` and `/auth/mfa/enrol/confirm`, and can never be presented as an access token —
`JwtAuthGuard`'s access-token path pins the API audience and rejects it.

**PR-API-07b** The `challengeToken` is a token, so PR-API-06 applies to it in full: the client
holds it in memory only and never in `localStorage`/`sessionStorage`.

**PR-API-07c** A wrong code and a wrong/expired/replayed `challengeToken` both return the same
opaque `401 /errors/unauthenticated` — the client is told nothing about which half failed. Failed
MFA attempts increment the **same** `app_user.failed_login_count` a failed password does, so five
bad codes lock the account exactly as five bad passwords do.

**PR-API-07d** An accepted code's RFC 6238 time step is persisted, so the same code cannot be
presented twice inside its own 30-second window (RFC 6238 §5.2).

## 3.3 Forced password change

**PR-API-07e** `POST /users` creates a user with an ADMIN-chosen password and
`must_change_password = true`. While that flag is set the user authenticates normally but
**every endpoint except `GET /auth/me`, `POST /auth/password` and `POST /auth/logout` returns
`403` with `type: /errors/password-change-required`**. The gate is deny-by-default: a new
endpoint is closed to a forced-change user unless it is explicitly allowlisted. Only the user's
own `POST /auth/password` clears it.

---

# 4. Authorisation

**PR-API-08** Every handler is guarded server-side (PR-090). The client hiding a control is a
usability affordance, never a security control (UR-074).

## 4.1 Permission matrix

`PLANNER` is the slice-18-WORKFLOW addition (owner decision, 2026-07-28 — named
`PLANNER`, deliberately not "SCHEDULER", which already names the background worker).
The change is **ADDITIVE**: every ✓ that existed before slice 18 is still there, and no
role lost any capability. PLANNER deliberately holds NO verification right — planning
work and independently checking it are different jobs (separation of duties); a person
who genuinely does both holds both roles, and the distinct-person rule still forbids one
human signing both verification stages.

| Capability | MAINTAINER | PLANNER | TEAM_LEADER | ENGINEER | DOC_CONTROLLER | ADMIN | AUDITOR |
|---|---|---|---|---|---|---|---|
| View own assigned jobs | ✓ | ✓ | ✓ | ✓ | | ✓ | |
| View all jobs in scope | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Record results / submit (signed) | ✓ | | ✓ | ✓ | | | |
| Raise an ad-hoc job | | ✓ | ✓ | ✓ | | ✓ | |
| Assign / reassign a job | | ✓ | ✓ | ✓ | | ✓ | |
| Verify a record | | | ✓ | ✓ | | | |
| Return a record | | | ✓ | ✓ | | | |
| Recall own submission | ✓ | | ✓ | ✓ | | | |
| Void a job | | | ✓ | ✓ | | ✓ | |
| Create/edit template revision | | | | ✓ | ✓ | | |
| Approve template revision | | | | | ✓ | | |
| Create/edit assets | | | | ✓ | | ✓ | |
| Adjust schedules | | ✓ | ✓ | ✓ | | ✓ | |
| Manage users and roles | | | | | | ✓ | |
| Create delegation | | | ✓ | ✓ | | ✓ | |
| View archive | ✓ (own) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| View audit trail | | | | | ✓ | ✓ | ✓ |
| Export records | | | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Modify anything** | | | | | | | **✗ — read-only** |

**Slice 18-WORKFLOW note on "Record results / submit"** — `POST /jobs/{id}/submit` now
carries the PERFORMER'S DRAWN SIGNATURE (mandatory). The plant's process is "completed
work — team member will sign and submit to team lead for checks"; the record now carries
three signatures (performer + two verifiers), matching the paper forms.

**PR-API-09** `AUDITOR` is enforced read-only at the database connection level, not only in
guards: auditor-scoped queries use the `bamform_readonly` role (DBD §7.1).

## 4.2 Scoping

**PR-API-10** Where a user has rows in `user_area_scope`, every collection query is filtered to
those areas. Absence of rows means unrestricted. Scoping is applied in the repository layer,
not by callers, so a new endpoint cannot forget it.

---

# 5. Error Model

**PR-API-11** All errors use RFC 9457 Problem Details, `Content-Type: application/problem+json`.

```json
{
  "type": "https://form.bevorasg.com/errors/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "3 items remain incomplete.",
  "instance": "/api/v1/jobs/0192f3.../submit",
  "requestId": "01JQ8X2N…",
  "errors": [
    { "pointer": "/items/7", "code": "REQUIRED", "message": "Item 7 has no recorded status" }
  ]
}
```

## 5.1 Error catalogue

| `type` suffix | HTTP | Meaning |
|---|---|---|
| `/errors/unauthenticated` | 401 | No or invalid access token |
| `/errors/step-up-required` | 403 | Re-authentication needed before signing (PR-API-07) |
| `/errors/password-change-required` | 403 | An admin-set password is still in force; only `/auth/me`, `/auth/password` and `/auth/logout` are reachable (PR-API-07e) |
| `/errors/forbidden` | 403 | Authenticated but not permitted |
| `/errors/out-of-scope` | 403 | Entity exists but is outside the user's area scope |
| `/errors/not-found` | 404 | |
| `/errors/self-approval` | 409 | Actor is the submitter or the revision author (INV-03, INV-05) |
| `/errors/invalid-transition` | 409 | State machine rejects the transition |
| `/errors/draft-conflict` | 409 | Client's base version is stale (PR-064) — body names the conflicting fields |
| `/errors/record-immutable` | 409 | Attempt to modify an archived record (INV-09) |
| `/errors/mfa-already-enrolled` | 409 | `POST /auth/mfa/enrol` on an account that already has an authenticator; only an ADMIN reset can clear it |
| `/errors/idempotency-mismatch` | 422 | Same key, different request body (DBD §6.23) |
| `/errors/validation-failed` | 422 | Field-level failures in `errors[]` |
| `/errors/incomplete-record` | 422 | Mandatory items outstanding (PR-045) — `errors[]` lists them |
| `/errors/revision-sequence-gap` | 422 | Would break revision contiguity (INV-02) |
| `/errors/spec-limits-inverted` | 422 | `lowerLimit > upperLimit` (INV-04) |
| `/errors/attachment-rejected` | 422 | Type, size or magic-byte check failed |
| `/errors/rate-limited` | 429 | `Retry-After` header present |
| `/errors/internal` | 500 | No internal detail leaked; `requestId` correlates to logs |

**PR-API-14a** `/errors/password-change-required` is not tied to any one path. It is raised by a
**global** deny-by-default guard, so **every authenticated endpoint in this document can return
it**, including endpoints whose `responses:` block in `api/openapi.yaml` lists no `403`. It is
documented here and on the shared `Problem` response rather than repeated on ~60 operations;
a client must handle the `type` globally, not per-screen (§3.3, PR-API-07e).

**PR-API-12** `detail` is safe to show a user. It never contains a stack trace, a SQL fragment,
an internal hostname, or decrypted personal data.

**PR-API-13** `/errors/incomplete-record` returns the full list of outstanding items, not just
a count. A technician on a phone must be able to tap straight to what is missing (UR-039).

---

# 6. Pagination

**PR-API-14** Cursor-based, not offset. Offset pagination over an append-heavy archive produces
duplicates and gaps as rows are inserted mid-scroll.

```
GET /api/v1/records?limit=50&cursor=eyJhIjoi...
```

```json
{
  "data": [ … ],
  "page": { "nextCursor": "eyJhIjoi…", "hasMore": true, "limit": 50 }
}
```

| Rule | Value |
|---|---|
| Default `limit` | 25 |
| Maximum `limit` | 100 |
| Cursor | Opaque base64. Clients must not construct or parse it |
| Total count | **Not returned by default.** `?includeTotal=true` performs the count query and is rate-limited separately |

**PR-API-15** Total counts are opt-in because `COUNT(*)` over a filtered archive is the query
most likely to be slow, and almost no screen needs it.

---

# 7. Idempotency

**PR-API-16** Every mutating endpoint accepts `Idempotency-Key: <uuid>`. It is **required** on
endpoints reachable from the offline outbox, and optional elsewhere.

| Behaviour | Response |
|---|---|
| First request with a key | Processed; response cached against the key for 30 days |
| Replay, same key, same body fingerprint | Original response replayed verbatim, `Idempotency-Replayed: true` |
| Replay, same key, **different** body | `422 /errors/idempotency-mismatch` — this indicates a client defect, not a retry |
| Key absent on a required endpoint | `422 /errors/validation-failed` |

**PR-API-17** The key is the mutation's client-generated UUIDv7 (PR-061), so a technician's
device generates it offline and it survives the queue. This is what guarantees that a
retransmitted record cannot be double-applied (PR-062).

---

# 8. Concurrency

**PR-API-18** Job drafts use optimistic concurrency on `job.draftVersion`. Mutations send
`If-Match: <draftVersion>`. A mismatch returns `409 /errors/draft-conflict` with the server's
current values for the conflicting fields.

**PR-API-19** The client presents both values and requires the technician to choose. Silent
last-write-wins is rejected for a quality record (PR-064).

**PR-API-20** Archived records return `ETag` and support `If-None-Match`, since they never
change — this makes the archive cheaply cacheable.

---

# 9. Rate Limiting

| Scope | Limit | Response |
|---|---|---|
| `POST /auth/login` | 10/min per IP, plus account lockout after 5 failures | 429 + `Retry-After` |
| `POST /auth/step-up` | 10/min per user | 429 |
| `POST /auth/mfa/enrol` | 10/min per user | 429 |
| `POST /auth/mfa/verify` | 10/min per user | 429 |
| `POST /auth/mfa/enrol/confirm` | 10/min per user | 429 |
| `POST /auth/mfa/recovery` | 5/min per user | 429 |
| `POST /auth/password` | 10/min per user | 429 |
| Authenticated general | 300/min per user | 429 |
| `POST /sync/outbox` | 60/min per user | 429 |
| `?includeTotal=true` | 10/min per user | 429 |
| `GET /records/{id}/pdf` | 30/min per user | 429 |

**PR-API-21** `POST /sync/outbox` has a deliberately generous limit. A technician returning from
a cleanroom with a day's work queued must not be rate-limited into failure — that is the
scenario the whole offline design exists to serve.

---

# 10. Endpoint Reference

Full schemas in `api/openapi.yaml`. Summarised here by resource group.

## 10.1 Health and metadata

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | none | Liveness. Returns version and commit SHA |
| `GET` | `/health/ready` | none | Readiness — checks Postgres, Redis, MinIO |
| `GET` | `/.well-known/jwks.json` | none | Token verification keys |

## 10.2 Authentication

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | §3 |
| `POST` | `/auth/refresh` | Rotation with reuse detection |
| `POST` | `/auth/logout` | |
| `POST` | `/auth/step-up` | PR-API-07 (password-only) |
| `POST` | `/auth/password` | Self-service password change, own account only (PR-API-07e) |
| `POST` | `/auth/mfa/enrol` | Begin TOTP enrolment (§3.2) |
| `POST` | `/auth/mfa/enrol/confirm` | Confirm enrolment; returns the recovery codes once |
| `POST` | `/auth/mfa/verify` | Complete login with a TOTP code |
| `POST` | `/auth/mfa/recovery` | Complete login with a single-use recovery code |
| `GET` | `/auth/me` | Current user, roles, area scope, active delegations |

## 10.3 Areas and assets

| Method | Path | Notes |
|---|---|---|
| `GET` `POST` | `/areas` | |
| `GET` `PATCH` | `/areas/{id}` | |
| `GET` `POST` | `/asset-types` | UR-001 |
| `GET` `PATCH` | `/asset-types/{id}` | |
| `GET` `POST` | `/assets` | UR-002. `POST` rejects duplicate `code` (INV-06) |
| `GET` `PATCH` | `/assets/{id}` | `PATCH` cannot delete; deactivation via `status` (UR-006) |
| `GET` | `/assets/{id}/history` | UR-007 — paginated record history |
| `GET` `PUT` | `/assets/{id}/schedule` | UR-023, UR-025. `PUT` requires `adjustedReason` |

## 10.4 Templates and revisions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/templates` | |
| `GET` | `/templates/{id}` | Includes current revision summary |
| `GET` | `/templates/{id}/revisions` | Full revision history (UR-011) |
| `POST` | `/templates/{id}/revisions` | Creates a `DRAFT`. Sequence assigned server-side (INV-02) |
| `GET` `PATCH` | `/revisions/{id}` | `PATCH` only while `DRAFT` |
| `PUT` | `/revisions/{id}/items` | Replace the checklist wholesale — simpler and safer than per-item diffing on a draft |
| `PUT` | `/revisions/{id}/measurements` | Validates `lowerLimit <= upperLimit` (INV-04) |
| `POST` | `/revisions/{id}/submit` | `DRAFT` → `PENDING_APPROVAL` |
| `POST` | `/revisions/{id}/approve` | `PENDING_APPROVAL` → `CURRENT`. Rejects self-approval (INV-03). **Requires step-up** |
| `POST` | `/revisions/{id}/reject` | Requires reason |

## 10.5 Jobs

| Method | Path | Notes |
|---|---|---|
| `GET` | `/jobs` | Filter: `status`, `assignedTo`, `assetId`, `dueFrom`, `dueTo`, `overdue` |
| `GET` | `/jobs/{id}` | Full job with frozen template content |
| `POST` | `/jobs/adhoc` | UR-028. Requires a reason >= 10 chars (audited, and DB-enforced by `job_adhoc_reason_length_chk`). PLANNER/TL/ENG/ADMIN. Neither satisfies nor advances `next_due_on` — created with an empty `frequency_scope` and excluded from the schedule-period key |
| `POST` | `/jobs/{id}/assign` | UR-029 |
| `PUT` | `/jobs/{id}/items/{templateItemId}` | Idempotency key required. `If-Match` on `draftVersion` |
| `PUT` | `/jobs/{id}/measurements/{templateMeasurementId}` | As above |
| `POST` `DELETE` | `/jobs/{id}/parts` `/jobs/{id}/parts/{partId}` | UR-034 |
| `POST` | `/jobs/{id}/attachments` | `multipart/form-data`. Magic-byte validated |
| `GET` | `/jobs/{id}/attachments/{attachmentId}` | **Streamed through the API** — authorisation on every fetch (PR-011) |
| `POST` | `/jobs/{id}/submit` | Completeness gate (PR-045) + the PERFORMER's drawn signature (mandatory, slice 18-WORKFLOW) — produces a stage-0 `approval_step` with an encrypted drawn signature and a content-bound Ed25519 signature |
| `POST` | `/jobs/{id}/recall` | Submitter only, while `SUBMITTED` (UR-051) |

## 10.6 Approval

| Method | Path | Notes |
|---|---|---|
| `GET` | `/queue` | The caller's verification queue, including delegated queues (PR-076) |
| `POST` | `/jobs/{id}/verify` | **Requires step-up.** Produces `approval_step` with content hash and signature |
| `POST` | `/jobs/{id}/return` | Reason ≥ 10 chars (INV-13) |
| `POST` | `/jobs/{id}/void` | Reason ≥ 10 chars (INV-12) |
| `GET` `POST` | `/delegations` | UR-052 |
| `DELETE` | `/delegations/{id}` | Revokes early; sets `revokedAt`, does not delete the row |

## 10.7 Archive and records

| Method | Path | Notes |
|---|---|---|
| `GET` | `/records` | Archived jobs. Filters per UR-058 |
| `GET` | `/records/{id}` | |
| `GET` | `/records/{id}/pdf` | Controlled-form layout (UR-056, PR-116) |
| `GET` | `/records/{id}/integrity` | **Recomputes the content hash and verifies the signature** (PR-095, AC-11) |
| `GET` | `/records/{id}/audit` | Audit events for this record |
| `POST` | `/records/export` | Async. Returns a job id; poll `/exports/{id}`. Produces ZIP of PDFs + CSV manifest (PR-119) |
| `GET` | `/exports/{id}` | Status and download link |

## 10.8 Reports

| Method | Path | Notes |
|---|---|---|
| `GET` | `/reports/compliance` | Due vs completed on time, by period/area/type (UR-067) |
| `GET` | `/reports/overdue` | UR-068 |
| `GET` | `/reports/pending-verification` | With ageing (UR-068) |
| `GET` | `/reports/measurements` | **Trend series** — `assetId` + `stableKey` + date range (UR-070). This is the endpoint field-level encryption on readings would have made impractical |
| `GET` | `/reports/{name}/export` | CSV/XLSX (UR-071) |

## 10.9 Audit and administration

| Method | Path | Notes |
|---|---|---|
| `GET` | `/audit-events` | Filter by entity, actor, action, date. `AUDITOR`/`DOC_CONTROLLER`/`ADMIN` only |
| `GET` | `/audit-events/chain-status` | Chain verification result (PR-097) |
| `GET` `POST` | `/users` | ADMIN only |
| `GET` `PATCH` | `/users/{id}` | Deactivation only, never deletion (UR-075) |
| `POST` | `/users/{id}/mfa-reset` | ADMIN only. Clears MFA enrolment and invalidates unused recovery codes; audited `mfa_reset` (§3.2) |
| `GET` | `/roles` | |
| `PUT` | `/users/{id}/roles` | Produces a `permission_change` audit event |
| `PUT` | `/users/{id}/area-scopes` | ADMIN only. REPLACES the user's PR-API-10 area-scope set (`[]` = unrestricted); soft-remove (`user_area_scope.active`), `permission_change` audit event |
| `GET` `PUT` | `/asset-types/{id}/approval-route` | Exposes PR-070 route configuration |

---

# 11. The Sync Protocol

The offline path (PRD §7). This is the highest-risk surface in the API and is specified
precisely.

## 11.1 Bootstrap

```
GET /api/v1/sync/bootstrap?since=2026-07-20T09:00:00Z
```

Returns everything the device needs to work disconnected:

```json
{
  "serverTime": "2026-07-24T02:15:00Z",
  "user": { "id": "…", "fullName": "…", "roles": ["MAINTAINER"] },
  "jobs": [ { "…full job with frozen template revision content…" } ],
  "deletedJobIds": ["…"],
  "syncToken": "eyJ0IjoiMjAyNi0wNy0yNFQwMjoxNTowMFoifQ"
}
```

**PR-API-22** The bootstrap payload embeds the **complete frozen template revision** for each
job — every checklist item, every measurement with its specification, all standing content.
The device must be able to render the full form with no further calls. A partial payload that
requires a lookup at the machine defeats the entire offline design.

**PR-API-23** `serverTime` is returned so the client can compute clock skew and flag it. A
device with a badly wrong clock produces `clientRecordedAt` values that are misleading
evidence.

## 11.2 Outbox drain

```
POST /api/v1/sync/outbox
```

```json
{
  "mutations": [
    {
      "id": "0192f3a1-…",
      "sequence": 41,
      "clientRecordedAt": "2026-07-24T01:14:22Z",
      "method": "PUT",
      "path": "/jobs/0192e7…/items/0192e8…",
      "ifMatch": 7,
      "body": { "status": "DONE", "remark": "Filter replaced" }
    }
  ]
}
```

Response — **per-mutation results, not all-or-nothing**:

```json
{
  "results": [
    { "id": "0192f3a1-…", "status": 200, "applied": true },
    { "id": "0192f3a2-…", "status": 409,
      "problem": { "type": "…/errors/draft-conflict", "…": "…" } }
  ],
  "syncToken": "…"
}
```

**PR-API-24** Mutations are applied in `sequence` order, transactionally per job. One failure
does not block the batch (PR-082) — the client retains only the failed mutations and surfaces
them for resolution.

**PR-API-25** Each mutation's `id` doubles as its idempotency key. Replaying the whole batch
after a network failure mid-response is safe and expected.

## 11.3 Submission

**PR-API-26** `POST /jobs/{id}/submit` is **never** sent as part of an outbox batch. It is a
separate, atomic call made only after every preceding mutation for that job has been
acknowledged. A record must never enter `SUBMITTED` on partially transmitted data (PR-065).

## 11.4 Attachments

**PR-API-27** Attachments upload on a separate channel and do not block submission (PR-067). A
record with attachments still in flight shows `upload_state: pending` and is **not verifiable**
until all have arrived — a verifier must not approve a record whose photographic evidence has
not landed.

---

# 12. Governance and CI Enforcement

| Gate | Tool | Fails the build when |
|---|---|---|
| Spec lint | Spectral, custom ruleset | Missing `operationId`, missing error responses, undocumented 4xx, unnamed schema, missing example |
| Spec/implementation agreement | Contract tests against the running API | Any divergence (PR-API-02) |
| Breaking change detection | `oasdiff` against the previous release | A breaking change is introduced without a version bump |
| Error envelope | Custom test | Any error response not conforming to RFC 9457 |
| Idempotency coverage | Custom test | A mutating endpoint reachable from the outbox lacks `Idempotency-Key` support |
| Auth coverage | Custom test | Any endpoint outside the public allowlist is reachable unauthenticated |
| Scope coverage | Custom test | Any collection endpoint returns rows outside the caller's area scope |

**PR-API-28** The "auth coverage" and "scope coverage" tests enumerate routes from the
application's own router rather than from a hand-maintained list. A newly added endpoint is
covered automatically; a developer cannot forget to add it to the test.

---

*End of document — BAMFORM-API-001 Revision 0.1*
