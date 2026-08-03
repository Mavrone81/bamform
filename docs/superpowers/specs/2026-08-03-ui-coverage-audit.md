# UI coverage audit — every backend capability, and whether anyone can reach it

Date: 2026-08-03
Purpose: the backlog the UI slices are cut from. Owner's standing rule, 2026-08-03:
**every feature built must have a corresponding screen.** This covers everything
built since the start of the project, not only recent slices.

## The headline

**85 API operations. 17 routes in the app.**

Roughly two-thirds of what the server can do has no way in. Most of it is built,
tested and green in CI — it is unreachable, not unfinished.

## Method

Endpoints counted from `api/openapi.yaml` (every path × method). Routes counted
from `web/src/App.tsx`'s `matchPath` calls. A capability counts as **reachable**
only if a screen actually calls it — not if an endpoint merely exists.

---

## Reachable today

| Capability | Route(s) | Notes |
|---|---|---|
| Sign in, refresh, password change, recovery codes | `/sign-in`, `/change-password` | MFA enrolment screens exist; `MFA_ENABLED` still defaults false |
| Job list and detail | `/jobs`, `/jobs/:id` | Filters by status, assignee, asset, overdue, due range |
| Record capture | `/jobs/:id` | Checklist, measurements, parts, attachments, offline outbox |
| Raise ad-hoc job | `/jobs/raise` | Picks document + frequency |
| Verifier queue and review | `/queue`, `/jobs/:id/review` | Two-stage verify, return, recall |
| Users and roles | `/admin/users`, `/new`, `/:id` | Create, edit, deactivate, area scopes |
| Machines | `/admin/machines`, `/new`, `/:id` | Create, edit; documents visible since slice 28 |
| Areas | `/admin/areas` | |
| Delegations | `/delegations` | |
| MFA reset | `/admin/mfa-reset` | Admin-initiated |
| Menu / admin home | `/menu`, `/admin` | Navigation only |

---

## Built and unreachable

Ordered by what blocks the plant most.

### 1. Schedule / planner — **nothing at all**

- **Endpoints:** `GET /assets/{assetId}/schedule`, `PATCH /assets/{assetId}/schedule`
- **Gap:** the only schedule endpoint is **per machine**. There is no
  cross-machine view, so "everything due in week 12" cannot be asked at all —
  the API for it does not exist, so this is not a UI-only slice.
- **Why it matters most:** this is what replaces `ML-S-MFT-00015`. After the
  migration lands, 77 machines will carry schedules **nobody can see**. The
  masterlist cannot be retired until this exists.
- **Needs:** a cross-machine schedule query, then a planner view by work
  week / month, plus the adjust action (`adjustedReason` is mandatory, min 10
  chars, and audited).

### 2. Forms and revisions — the form creator

- **Endpoints (9):** `POST/GET /templates`, `GET/PATCH /templates/{id}`,
  `POST/GET /templates/{id}/revisions`, `PATCH /revisions/{id}`,
  `PUT /revisions/{id}/items`, `PUT /revisions/{id}/measurements`,
  `POST /revisions/{id}/submit|approve|reject`
- **Gap:** a complete document-control lifecycle — draft, submit, approve,
  versioned revisions — with **no screen**. The only way to author a form today
  is to write an Excel file in the exact CE-95 layout and run the loader.
- **Consequence:** `MS-620 ST01` has no PM form and cannot get one in the app.
- **Needs:** create form, edit revision, checklist items with frequency,
  measurements with spec ranges, standing content, then submit → approve.

### 3. Archive search and records

- **Endpoints:** `GET /records`, `GET /records/{id}`, `GET /records/{id}/pdf`,
  `GET /records/{id}/integrity`
- **Gap:** the PDF is reachable from a job, but there is no way to **find** a
  past record — no search by machine, date, document or status.
- **Needs:** a search screen, and a record view exposing the integrity check.

### 4. Reports and trending

- **Endpoints (4):** `/reports/...`
- **Gap:** `ReportsModule` is built and tested; nothing calls it.

### 5. Exports

- **Endpoints (2):** `/exports/...` (ZIP + CSV)
- **Gap:** `ExportsModule` is built and tested; nothing calls it. This is how an
  auditor is given a period's records in bulk.

### 6. Asset types

- **Endpoints (4):** list, create, update, plus approval-route wiring
- **Gap:** appears only as a **filter dropdown** on the machines screen. The
  approval route and lead time that every machine family inherits cannot be
  seen or changed.

### 7. Approval routes

- **Endpoint:** `GET /approval-routes`
- **Gap:** who signs what, and in what order, is invisible and unconfigurable.

### 8. Audit and integrity chain

- **Endpoint:** `GET /audit-events`, plus chain-status
- **Gap:** the hash-chained audit trail is the backbone of the ISO claim and has
  no screen. A break is currently discoverable only by calling the API by hand.

### 9. Asset documents — partial

- **Endpoints:** `GET/POST /assets/{assetId}/documents`, `PATCH /asset-documents/{id}`
- **State:** documents are **visible** on a machine (slice 28). Whether they can
  be attached, renumbered or deactivated from the UI needs confirming per
  action — `PATCH` exists specifically to change a form number, which the
  masterlist migration will rely on for corrections.

---

## Not needed in the UI

- `/sync/*` — the offline outbox drains itself.
- `/health`, `/healthz`, `/.well-known/*` — operational.
- `/roles` — consumed by the user screens.

---

## What this means for sequencing

1. **Masterlist migration** (in progress) — a CLI, correctly. One-time,
   operator-run, needs shell access. But its output is only partly visible.
2. **Planner** — unblocks retiring the spreadsheet, and makes the migration's
   result inspectable. Needs API work, not only a screen.
3. **Form creator** — unblocks `MS-620 ST01` and ends the Excel round trip.
4. **Archive search, exports, reports, audit, asset types, approval routes** —
   individually small, mostly CRUD over endpoints that already exist.

**Design the navigation once, across all of it.** Items 2–4 add roughly a dozen
screens to an app that currently has 17 routes. Restyling the existing screens
first and then attaching a dozen more would mean doing the information
architecture twice.

## Honest limits of this audit

- Reachability was judged from routes and screen names. A screen may call fewer
  endpoints than its area suggests — for example the machines screen exists, but
  whether every asset-document action is wired needs checking per action.
- "Built and tested" means the endpoint exists with server-side tests. It does
  not mean the behaviour has been exercised end to end by a person.
