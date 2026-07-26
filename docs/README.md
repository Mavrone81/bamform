# BamForm Documentation Set

Preventive maintenance record and approval system.
Repository `git@github.com:Mavrone81/bamform.git` · Service `https://form.bevorasg.com`

---

## Status

| Phase | Deliverable | Status |
|---|---|---|
| Phase 0 | Server recon, port deconfliction | **Blocked — OI-07, no server access** |
| Phase 1 | URD | **Approved, Rev 1.0** |
| Phase 1 | PRD | Issued Rev 0.2 — awaiting sign-off |
| Phase 1 | Technical document set | Issued Rev 0.1 — awaiting sign-off |
| Phase 2 | Implementation | **Not started.** Begins only after the above are approved |

---

## Documents

| # | Document | File | Rev | Read it for |
|---|---|---|---|---|
| 1 | User Requirement Document | [`URD.md`](URD.md) | **1.0 Approved** | What the system must do, in business language. 116 requirements, 7 personas, 7 journeys, 18 acceptance criteria |
| 2 | Product Requirement Document | [`PRD.md`](PRD.md) | 0.2 | How it will be built. 121 product requirements, architecture, technology selection with rejected alternatives, traceability matrix, effort estimate, risk register |
| 3 | Database Design | [`DATABASE_DESIGN.md`](DATABASE_DESIGN.md) | 0.1 | ERD, table-by-table data dictionary with classification and encryption marking, 16 database-enforced invariants, indexing, migration rules |
| 4 | Environment Requirements | [`ENVIRONMENT_REQUIREMENTS.md`](ENVIRONMENT_REQUIREMENTS.md) | 0.1 | Every configuration variable with type, default, required flag and secret flag. Sizing, backup, restore verification battery |
| 5 | API Specification | [`API_SPECIFICATION.md`](API_SPECIFICATION.md) | 0.1 | Conventions, RFC 9457 error catalogue, permission matrix, idempotency, the offline sync protocol |
| — | *API contract* | [`../api/openapi.yaml`](../api/openapi.yaml) | — | **The machine-readable contract.** 29 paths, 33 schemas. Lint-checked in CI |
| 6 | Workflow Diagrams | [`WORKFLOW_DIAGRAMS.md`](WORKFLOW_DIAGRAMS.md) | 0.1 | Every process flow in Mermaid — generation, cascade, offline sync, approval, rework, delegation, escalation, recall, void, revision control, audit, notification |
| 7 | Security Architecture | [`SECURITY_ARCHITECTURE.md`](SECURITY_ARCHITECTURE.md) | 0.1 | Data classification, STRIDE threat model, key hierarchy and rotation, incident playbooks, seven accepted residual risks |
| 8 | Deployment and Runbook | [`DEPLOYMENT_RUNBOOK.md`](DEPLOYMENT_RUNBOOK.md) | 0.1 | Deploy flow, rollback decision tree, 15 failure modes, restore procedure. **Starts with prohibited commands** |
| 9 | Test Plan | [`TEST_PLAN.md`](TEST_PLAN.md) | 0.1 | All test levels, coverage targets, the 16-case offline release gate, 34 security cases, UAT |
| 10 | Template Load Plan | [`TEMPLATE_LOAD_PLAN.md`](TEMPLATE_LOAD_PLAN.md) | 0.1 | Verified load of the twelve source documents, disposition of nine identified source defects |
| 11 | Architecture Decision Records | [`ADR.md`](ADR.md) | 0.1 | Thirteen decisions, their alternatives, and what would make each one wrong |
| 12 | Software Validation Plan | [`VALIDATION_PLAN.md`](VALIDATION_PLAN.md) | 0.1 | ISO 13485 clause 4.1.6 validation: risk assessment, IQ/OQ/PQ, revalidation, Part 11 delta. Created on resolution of OI-01 |
| 13 | Build Handoff | [`BUILD_HANDOFF.md`](BUILD_HANDOFF.md) | 0.1 | Instructions for the implementing agent: read order, build order, 12 non-negotiables, post-issue deltas |

---

## Where to start

**Client / sign-off authority** → URD, then PRD §0, §14 (release plan and effort), §15 (risks),
§20 (decisions requiring acknowledgement).

**Quality / Document Control** → URD §1.2 (defects in the current process), SEC §13 (ISO 9001
clause mapping), TLP (template verification and your sign-off sheet).

**Engineer joining the project** → ADR first, then PRD, then DBD.

**Operations** → RUN §1 (prohibited commands) before anything else.

---

## Open issues

Eight carried from URD §8. Three materially block progress.

| ID | Issue | Blocks |
|---|---|---|
| **OI-07** | **Server access — IP, SSH user, auth method, production or staging** | **Phase 0 recon, proxy selection, all deployment work** |
| ~~OI-01~~ | **RESOLVED: ISO 9001 + ISO 13485.** Validation plan issued; MFA moved to R1; effort ~40 wks. Residual question: does 21 CFR Part 11 apply (US FDA product)? | VAL plan §9 |
| **OI-02** | Machine count for sizing | ENV §6, PRD §14.3 |
| OI-03 | Retention period — 7 years assumed | Storage sizing only |
| OI-04 | One or two verification signatures | Configuration only — ADR-011 |
| OI-05 | Out-of-spec handling | R2 scope only |
| OI-06 | Which DMS, and export or integration? | R1 unaffected |
| OI-08 | 1M cascade rule on `CE 95 043 00 01` | Accommodated by PR-054 |

Additionally blocking the template load (TLP §8.2):

- **B-04** — the `95 - 28 g` specification on `CE 95 020 00 01` cannot be loaded as written
- **B-09** — the real machine codes for every document

---

## Decisions requiring client acknowledgement

Departures from the master build prompt, each with a stated reason:

- [ ] Next.js rejected in favour of a React + Vite PWA — ADR-001
- [ ] Field-level encryption confined to personal data — ADR-004, SEC RS-1
- [ ] Postgres RLS and JWE not implemented — ADR-005, PRD §12.4
- [ ] Content-bound electronic signatures added beyond the specification — ADR-010
- [ ] MFA is TOTP at login for privileged roles only; `MAINTAINER` logs in with a password alone, and step-up before signing stays password-only — SEC RS-3 (withdrawn as written, surviving as the MAINTAINER exemption), BUILD_HANDOFF §5
- [ ] No automatic rollback on failed deploy — ADR-012
- [ ] Indicative effort of 34 engineer-weeks accepted as a planning basis — PRD §14.2

---

## Conventions

- Requirement IDs: `UR-xxx` user, `PR-xxx` product, `INV-xx` database invariant, `AC-xx`
  acceptance criterion, `RK-xx` risk, `RS-x` residual risk, `OI-xx` open issue, `B-xx` source
  document defect.
- Every `UR-xxx` traces to at least one `PR-xxx` (PRD §18) and at least one test (TST §18).
- Documents carry a revision history and are revised, not overwritten. ADRs are appended only.
- Diagrams are Mermaid, held inline. There is no binary artefact to fall out of date.
