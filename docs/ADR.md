# Architecture Decision Records
## BamForm — Preventive Maintenance Record and Approval System

---

## Document Control

| Field | Value |
|---|---|
| Document title | Architecture Decision Records — BamForm |
| Document number | BAMFORM-ADR-001 |
| Revision | 0.1 |
| Status | Living document — appended, never rewritten |
| Date issued | 24 July 2026 |
| Prepared by | Lead Engineer, BamForm project |
| Classification | Internal |

### Why this document exists

Proposed as an additional deliverable, with this justification: **RK-10 identifies single-point
knowledge concentration as a project risk.** Six months from now, a different engineer will ask
"why isn't this Next.js?" and "why aren't the readings encrypted?" A decision without a recorded
reason gets reversed by whoever holds the keyboard next. Each record below is dated, states the
alternatives considered, and — critically — states what would make the decision wrong.

**Records are appended, never edited.** A superseded decision gets a new record that supersedes
it, so the reasoning trail survives.

---

## Index

| ADR | Decision | Status |
|---|---|---|
| ADR-001 | React + Vite PWA, not Next.js | Accepted |
| ADR-002 | NestJS + TypeScript, not FastAPI | Accepted |
| ADR-003 | Template content normalised, not JSONB | Accepted |
| ADR-004 | Field encryption confined to personal data | Accepted |
| ADR-005 | No Postgres row-level security | Accepted |
| ADR-006 | Redis retained over a Postgres-backed queue | Accepted, reversible |
| ADR-007 | Attachments served through the API, not presigned URLs | Accepted |
| ADR-008 | Offline outbox with client-generated idempotency keys | Accepted |
| ADR-009 | Next due date computed from last completion, not anchor | Accepted |
| ADR-010 | Content-bound electronic signatures | Accepted |
| ADR-011 | Approval route stored as data | Accepted |
| ADR-012 | No automatic rollback on failed deploy | Accepted |
| ADR-013 | Workflow transitions as POST sub-resources, not PATCH | Accepted |

---

## ADR-001 — React + Vite PWA, not Next.js

**Date:** 23 Jul 2026 · **Status:** Accepted · **Supersedes:** the master build prompt's
recommended frontend

**Context.** The master prompt recommends Next.js + Tailwind. UR-038 makes offline record
completion a Must-have, and UR-088 requires queued records to transmit within 60 seconds of
reconnection.

**Decision.** Client-rendered React 19 SPA, built by Vite, delivered as an installable PWA with
a service worker.

**Reasoning.** Offline-first means the client owns the data and the rendering while
disconnected. Server-side rendering is the opposite posture. Next.js can be coerced into static
export, but every SSR benefit it offers — fast first paint for anonymous visitors, SEO, server
components — is worthless for an authenticated internal tool used by around a hundred named
people, while its routing and data conventions complicate service-worker cache control. The
secondary benefit is operational: a Vite build is static files served by the existing proxy, so
there is no Node SSR process to run, supervise, patch or restart on a shared live host (CN-01).

**Rejected.** Next.js (above). HTMX or server-rendered forms — cannot satisfy UR-038 at all.
Vue — no technical objection; React chosen for ecosystem depth in offline sync and PDF tooling.

**This becomes wrong if:** the offline requirement is dropped, or the application acquires a
public unauthenticated surface where first-paint performance matters commercially.

---

## ADR-002 — NestJS + TypeScript, not FastAPI

**Date:** 23 Jul 2026 · **Status:** Accepted

**Context.** Both candidates generate OpenAPI well, so that criterion does not separate them.

**Decision.** NestJS on Node 22, TypeScript strict mode.

**Reasoning.** Validation logic must exist in two places: the offline client validates a record
before accepting it into the outbox, and the server validates it again on arrival (PR-007).
With TypeScript on both sides, one set of Zod schemas is the source of truth for both, shared
as an internal package. A Python backend would require that logic written twice in two
languages and kept in step — a defect source in exactly the area where correctness matters
most, and a silent one, because the two would diverge gradually.

**Rejected.** FastAPI (above). Django — its admin is attractive for UR-072 but its ORM and
template conventions fight an API-first offline client. Laravel — no advantage here.

**This becomes wrong if:** the offline client is dropped, or the team's Python expertise
substantially exceeds its TypeScript expertise.

---

## ADR-003 — Template content normalised, not JSONB

**Date:** 24 Jul 2026 · **Status:** Accepted

**Context.** Storing each template revision's checklist as a single JSON blob would be faster to
build and simpler to version.

**Decision.** Checklist items and measurements are normalised rows. Only standing content — PPE
list, tools, safety and procedure text — is JSONB.

**Reasoning.** UR-070 requires trending a specific measurement for a specific asset over time:
heater block temperature on AW03 across eight quarters. That is a query against normalised rows
joined by `stable_key` across revisions. As JSONB it becomes an application-side scan of every
historical record. The standing content is exempt because it is displayed whole and never
queried.

**Rejected.** Full JSONB. Hybrid with duplicated instruction text on every result row —
denormalisation that would have to be kept consistent with no benefit, since revisions are
immutable once current.

**This becomes wrong if:** measurement trending is dropped from scope.

---

## ADR-004 — Field encryption confined to personal data

**Date:** 23 Jul 2026 · **Status:** Accepted · **Requires client acknowledgement**

**Context.** The master prompt specifies AES-256-GCM field-level encryption throughout, with
per-tenant envelope encryption and blind indexes.

**Decision.** Field-level encryption applies to `app_user` personal columns only. Maintenance
readings, checklist results, instructions and specifications are stored in cleartext at column
level, protected by storage encryption, network isolation and service-layer authorisation.

**Reasoning.** This is a requirement conflict, not a preference. Field-encrypting
`measurement_result.reading_numeric` would make UR-070 trending and UR-067 compliance
aggregation undeliverable at acceptable performance — the database could not filter, order or
aggregate the values. Separately, the threat model does not support it: the realistic
consequence of disclosing maintenance checklist content is exposure of internal equipment
procedures, which is commercially unwelcome but is not a personal-data breach. The engineering
effort is better spent on offline sync correctness, where a defect loses a technician's
completed record — an actual compliance failure.

**Rejected.** Uniform field encryption (above). Encrypting readings but exposing a cleartext
"trending shadow column" — the worst of both, since the shadow column is the disclosure.

**Residual risk:** RS-1 in BAMFORM-SEC-001 §14, accepted.

**This becomes wrong if:** the client classifies maintenance content as trade secret requiring
cryptographic protection at rest, or if the system becomes multi-tenant.

---

## ADR-005 — No Postgres row-level security

**Date:** 23 Jul 2026 · **Status:** Accepted

**Context.** The master prompt mandates RLS for tenant isolation.

**Decision.** RLS is not implemented. Access is enforced at the service layer with mandatory
query scoping applied in the repository layer.

**Reasoning.** AS-05 establishes a single tenant — one organisation, one site. RLS for tenant
isolation with one tenant adds operational complexity and a second place for authorisation
logic to live and diverge, protecting against nothing. The database-level control that *is*
retained is more valuable here: the application role holds no `UPDATE` or `DELETE` on
`audit_event` or `approval_step` (PR-099), so an application compromise cannot rewrite history.

**Rejected.** RLS for tenant isolation. RLS for area scoping — the scoping rules involve
delegation resolution and role sets that are awkward to express as policies and easy to get
subtly wrong.

**This becomes wrong if:** AS-05 is reversed — a second site, a second legal entity, or any
multi-tenant model.

---

## ADR-006 — Redis retained over a Postgres-backed queue

**Date:** 23 Jul 2026 · **Status:** Accepted, **explicitly reversible**

**Context.** The `165` server is shared and live. Every additional container is footprint on
someone else's host.

**Decision.** Redis 7 for the notification queue (BullMQ), rate limiting, the refresh-token
denylist and the scheduler lock.

**Reasoning.** BullMQ's delayed-job primitive is what the escalation timers (UR-050) and
due-date reminders (UR-062) need directly. The token denylist wants native TTL semantics.

**Rejected but genuinely viable.** pg-boss would deliver the same queue on Postgres and remove
a container. At 100 users this is entirely sufficient. Redis was chosen because the delayed-job
and rate-limit primitives are materially better and the container costs about 30 MB.

**Reversibility is the point of this record.** The decision is confined to two modules. If the
recon shows the host is tighter than expected, or the client prefers a minimal footprint, this
reverses at no architectural cost.

---

## ADR-007 — Attachments served through the API, not presigned URLs

**Date:** 24 Jul 2026 · **Status:** Accepted

**Context.** Presigned URLs are the conventional S3 pattern and offload bandwidth from the API.

**Decision.** Every attachment fetch streams through `api`.

**Reasoning.** UR-074 requires authorisation on every access. A presigned URL is a bearer
capability with a time window — once issued it cannot be scoped to a role change, a
deactivation, or an area-scope change, and it can be forwarded. Attachment volume here is
photographs of machine parts at a few thousand per year, so the bandwidth argument is
negligible. Streaming through the API also means the SSE-S3 key never has to be exposed to a
client.

**Rejected.** Presigned URLs. Public bucket with obscure keys — security by URL obscurity.

**This becomes wrong if:** attachment volume grows by two orders of magnitude, or video is
introduced.

---

## ADR-008 — Offline outbox with client-generated idempotency keys

**Date:** 24 Jul 2026 · **Status:** Accepted

**Context.** A technician records work in a cleanroom with no signal, then reconnects. The
transmission may fail, partially succeed, or succeed with the response lost.

**Decision.** Every mutation is appended to a local IndexedDB outbox with a client-generated
UUIDv7 that doubles as its `Idempotency-Key`. The outbox drains in sequence order. The server
records processed keys for 30 days and replays the original response on retry. Submission is a
separate atomic call made only after all preceding mutations are acknowledged.

**Reasoning.** RK-01 — losing a completed record — is the highest-impact risk in the project.
Client-generated keys are the only mechanism that makes a retransmission provably safe, because
the key is created before the network is involved and survives in durable device storage.

**Rejected.** Server-generated keys — useless, since the client must generate offline.
Last-write-wins conflict resolution — unsafe for a quality record; conflicts surface to the
technician instead (PR-064). CRDTs — enormous complexity for a document with one owner.

**This becomes wrong if:** never, while offline capture is in scope.

---

## ADR-009 — Next due date computed from last completion, not anchor

**Date:** 24 Jul 2026 · **Status:** Accepted

**Context.** A schedule can be anchored (every 1 March) or rolling (three months after last
completion).

**Decision.** `next_due_on = last_completed_on + interval_months`.

**Reasoning.** Anchored scheduling means a job completed a week late immediately generates its
successor, or generates one due almost immediately. Technicians would see PM jobs appearing
faster than they could complete them, and compliance figures would degrade for a reason that
has nothing to do with maintenance. Rolling scheduling absorbs the drift.

**Rejected.** Fixed-calendar anchoring. Hybrid with drift correction — more complex, and the
client has not asked for calendar alignment.

**This becomes wrong if:** the client requires PM aligned to a fixed audit calendar. The anchor
date is already stored, so this reverses cheaply.

---

## ADR-010 — Content-bound electronic signatures

**Date:** 23 Jul 2026 · **Status:** Accepted · **Beyond the master specification**

**Context.** The master prompt specifies a hash-chained audit log but not signature
manifestation or content binding.

**Decision.** On each approval, the server builds a canonical deterministic serialisation of
the entire record, hashes it SHA-256, signs the digest with a dedicated Ed25519 key, and stores
both. `GET /records/{id}/integrity` recomputes and verifies on demand.

**Reasoning.** The question an ISO auditor actually asks is "how do you know this record hasn't
changed since it was signed?" An audit log answers "here is what we recorded happening"; it does
not answer that question. Only a signature that commits to the content does. This is also what
makes a future ISO 13485 or 21 CFR Part 11 scope additive rather than structural.

**Consequence.** The serialisation must be byte-deterministic across hosts, versions and time,
which is why the golden-hash determinism test (U-SIG-01) is the most important single test in
the suite. Without it, a dependency upgrade would begin reporting false tampering on every
historical record.

**Rejected.** Audit log alone. Per-user signing keys — impractical on shared shop-floor devices,
and keys would end up shared, which is worse than no per-user key (RS-6).

---

## ADR-011 — Approval route stored as data

**Date:** 24 Jul 2026 · **Status:** Accepted

**Context.** The client described a single verification stage. All twelve source documents show
two signature blocks — Team Leader **and** Supervisor/Engineer. This discrepancy is open issue
OI-04 and may resolve either way.

**Decision.** The route is `approval_route` → ordered `approval_stage` → `approval_stage_role`.
The delivered configuration is one stage satisfied by `TEAM_LEADER` or `ENGINEER`.

**Reasoning.** Building the client's stated route as hardcoded logic would make OI-04 a rework
item. As data, reinstating the second signature is two INSERT statements and one UPDATE — no
migration, no code change, no redeployment. An open issue that would otherwise be High impact
becomes Low (RK-06).

**Rejected.** Hardcoded single-stage. A general workflow engine — vastly more than this domain
needs, for routes that are two stages at most.

---

## ADR-012 — No automatic rollback on failed deploy

**Date:** 24 Jul 2026 · **Status:** Accepted, pending client override

**Context.** The master prompt offers automatic rollback on failed health check "if I approve
that behaviour".

**Decision.** A failed post-deploy health check logs loudly and alerts. It does not
automatically roll back. A human decides.

**Reasoning.** Migrations run before the application restarts. If a health check fails *after*
migrations applied successfully, automatic code rollback produces old code against a new
schema — a different and possibly worse broken state, arrived at automatically at 3am with
nobody watching. The safety that matters is already in place: migration failure aborts the
deploy without restarting the application, so the previous version keeps serving.

**Rejected.** Automatic rollback. Automatic rollback only when no migration ran — plausible,
and can be added if the client wants it, but it introduces a conditional path in the deploy
script that is exercised rarely and therefore trusted more than it is tested.

**This becomes wrong if:** the client accepts the schema-mismatch risk in exchange for faster
unattended recovery.

---

## ADR-013 — Workflow transitions as POST sub-resources, not PATCH

**Date:** 24 Jul 2026 · **Status:** Accepted

**Context.** `PATCH /jobs/{id} {status: "VERIFIED"}` is more RESTful-looking than
`POST /jobs/{id}/verify`.

**Decision.** Transitions are `POST` to a sub-resource: `/submit`, `/verify`, `/return`,
`/recall`, `/void`.

**Reasoning.** A state transition here is not a field edit. It has preconditions (completeness,
role eligibility, not-the-submitter), side effects (signature generation, schedule reset,
notification, timer cancellation), its own authorisation, and its own step-up requirement.
Modelling it as a field update invites clients — and future developers — to treat it as data,
and makes it easy to write an endpoint that sets the status without doing the rest.

**Rejected.** `PATCH` on a status field. A generic `/transitions` endpoint taking a verb — loses
per-transition request schemas and per-transition documentation.

---

*End of document — BAMFORM-ADR-001 Revision 0.1*
