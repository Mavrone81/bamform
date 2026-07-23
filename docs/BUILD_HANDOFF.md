# Build Handoff — Instructions for the Implementing Agent
## BamForm — Preventive Maintenance Record and Approval System

| Field | Value |
|---|---|
| Document number | BAMFORM-BLD-001 |
| Revision | 0.1 |
| Date | 24 July 2026 |
| Audience | The coding agent ("codex") implementing BamForm |
| Authority | This document ranks BELOW the documents it indexes. If it contradicts them, they win and this document has a defect |

---

# 1. Read Order

Do not start coding from this file. Read in this order:

1. `docs/ADR.md` — thirteen decisions already made, with the alternatives already rejected. **Do not relitigate them.** If you believe one is wrong, stop and raise it; each ADR states its own reversal condition.
2. `docs/PRD.md` — the 121 product requirements. §0 indexes the whole set.
3. `docs/DATABASE_DESIGN.md` — the schema you will implement, including 16 invariants that live in the **database**, not in your service layer.
4. `docs/API_SPECIFICATION.md` + `api/openapi.yaml` — the contract. The YAML is authoritative; CI fails on divergence.
5. `docs/WORKFLOW_DIAGRAMS.md` — the exact sequencing of every flow, including the offline sync protocol.
6. `docs/SECURITY_ARCHITECTURE.md` §8.1 — canonical serialisation rules. Get this wrong and every historical signature breaks.
7. `docs/TEST_PLAN.md` — every test you must write. IDs are pre-assigned (U-SIG-01, O-15, S-22 …); use them as test names.

`docs/URD.md`, ENV, RUN, TLP, VAL are reference; consult as needed.

# 2. Repository State

Already present and validated — extend, don't replace:

```
docker-compose.yml          7 services, 3 networks, 10 secrets, limits on everything
docker-compose.ci.yml       ephemeral CI stack
api/Dockerfile              multi-stage, non-root uid 10001, Chromium + tini
web/Dockerfile              Vite build → nginx-unprivileged static
web/nginx.conf              CSP with no unsafe-*, sw.js never cached
api/openapi.yaml            29 paths, 33 schemas — the contract
db/init/01-roles.sql        role scaffold (grants applied post-migration)
.env.example                57 keys — CI asserts completeness (PR-ENV-26)
.github/workflows/ci.yml    11 gated jobs
scripts/ci/*.sh             7 assertion scripts the workflow calls
scripts/server/*.sh         deploy + backup (server install, not app code)
scripts/recon.sh            Phase 0 sweep (operator runs it, not you)
```

Expected layout you will create: npm workspaces `api/`, `web/`, `shared/`. The Dockerfiles
already assume this — `shared/` holds the Zod schemas used by BOTH client and server (ADR-002:
this shared-validation property is the reason the stack is TypeScript; do not duplicate
validation logic per side).

# 3. Build Order

Sequence chosen so each phase's tests can run before the next starts:

| # | Slice | Key requirements | Done when |
|---|---|---|---|
| 1 | Workspaces scaffold, Prisma schema from DBD §6, migrations incl. triggers/grants | INV-01..16, PR-DBD-04..09 | Integration tests I-INV-01..11 pass |
| 2 | Auth: Argon2id, EdDSA tokens, refresh rotation + reuse detection, step-up, JWKS | PR-083..092 | S-01..S-09 pass |
| 3 | Crypto: field encryption w/ AAD, blind index, canonical serialisation + signing | PR-093/094, PR-106..108, PR-SEC-13 | U-ENC-*, **U-SIG-01 golden hash committed** |
| 4 | Assets, areas, templates, revision lifecycle | PR-019..028, PR-047..049 | I-INV-01..04, I-INV-18 |
| 5 | Scheduler: cascade, idempotent generation, Redis lock, completion cascade | PR-050..058 | U-CAS-01..10, I-INV-14/15 |
| 6 | Jobs, results, parts, attachments (streamed, magic-byte), submission gate | PR-030..034, PR-045, PR-011/012 | S-19, S-30 |
| 7 | Approval: routes-as-data, verify/return/recall/void, signatures, archive-in-txn | PR-041..046, PR-070..077 | S-22..S-25, I-INV-13 |
| 8 | Audit chain: same-txn writes, hash chain, daily verification, integrity endpoint | PR-095, PR-097..099 | I-INV-11/12, S-10/S-11 |
| 9 | Sync API: bootstrap w/ embedded frozen revision, outbox, idempotency store | PR-API-22..27, PR-062 | I-INV-16/17 |
| 10 | PWA: shell, IndexedDB outbox, sync states, capture UI, mobile-first | PR-013/014, PR-059..069 | **Offline gate O-01..O-16** |
| 11 | Verifier queue UI, delegation, notifications, escalation timers | PR-076/077 | E-02..E-04, E-10 |
| 12 | PDF render (worker, concurrency 2), archive search, export, reports/trending | PR-116..119 | E-11..E-14, P-08/P-09 |
| 13 | Admin UI, MFA (now R1 — see §5), a11y pass, template load tooling per TLP | UR-072..075 | A-01..A-07, E-06 |

# 4. Non-Negotiables

These are the properties most likely to be quietly broken by a reasonable-looking refactor.
Each has a CI tripwire, but do not rely on tripping it:

1. **The outbox entry is cleared only after server acknowledgement** (PR-WFD-05, tested by O-15's injected failure). Never clear optimistically.
2. **Submit is never part of an outbox batch** (PR-API-26). Separate atomic call after all mutations acknowledged.
3. **Audit writes share the transaction with the change** (PR-098). An action that can't be audited doesn't happen.
4. **`VERIFIED → ARCHIVED` in one transaction** (PR-042). No resting verified-but-editable state.
5. **Canonical serialisation is byte-deterministic** (PR-SEC-13). Sorted keys, fixed decimals, NFC, explicit nulls. The golden hash (U-SIG-01) is committed in slice 3 and never regenerated casually — if it changes, you broke something, not the test.
6. **No authorisation in `web`** (PR-007). Every rule enforced server-side; the route-coverage test enumerates from the router, so new endpoints are auto-covered.
7. **No `DELETE` anywhere on record tables; app role has no `UPDATE` on audit/approval tables** (PR-099). If you find yourself needing UPDATE on `audit_event`, the design is telling you no.
8. **Data services publish no host port, ever, including local dev** (PR-ENV-11). Debug via `docker compose exec`.
9. **Secrets are file-mounted, never env vars, never logged** (PR-SEC-15/16, PR-ENV-21). Redaction lives in the log serialiser, not at call sites.
10. **`localStorage` never holds a token** (PR-085). Access token in memory; refresh in the HttpOnly cookie.
11. **Workflow transitions are POST sub-resources** (ADR-013). Do not add a `PATCH {status}` path "for convenience".
12. **Overdue is derived, never stored** (PR-043).

# 5. Deltas Since the Documents Were Issued

Apply these on top of the issued Rev 0.1/0.2 documents — they postdate them:

- **ISO 13485 confirmed (OI-01).** Validation plan is `docs/VALIDATION_PLAN.md`. **MFA moves into Release 1** (SEC RS-3 is withdrawn). Build TOTP enrolment in slice 13; step-up before signing remains as well.
- **B-04**: the `95 - 28 g` spec on `CE 95 020 00 01` is corrected to **95–105 g via client-issued revision D** before load. Your TLP tooling loads revision D; do not code a workaround for the inverted range — INV-04 stays.
- **Effort baseline is ~40 engineer-weeks**, not 34.
- **Open**: 21 CFR Part 11 (if yes: signature-meaning statement at enrolment + at signing — extend PR-096); machine count (OI-02); recon output (ports still `${WEB_PORT:?}`/`${API_PORT:?}` — leave them failing-fast until assigned).

# 6. Definition of Done (per slice)

Code + tests with the pre-assigned IDs + green pipeline through the relevant gate + no new
`docs/` contradiction. If implementation forces a deviation from any PR-xxx, do not silently
diverge: record it as a new ADR entry (append-only) and flag it for review. The traceability
chain UR → PR → test is the audit trail; a silent deviation breaks it at the middle link.

*End of document — BAMFORM-BLD-001 Revision 0.1*
