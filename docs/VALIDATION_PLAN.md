# Software Validation Plan
## BamForm — Preventive Maintenance Record and Approval System

---

## Document Control

| Field | Value |
|---|---|
| Document title | Software Validation Plan — BamForm |
| Document number | BAMFORM-VAL-001 |
| Revision | 0.1 |
| Status | **Draft — for client review** |
| Date issued | 24 July 2026 |
| Prepared by | Lead Engineer, BamForm project |
| Approved by | _(to be completed — Quality function)_ |
| Classification | Internal |
| Parent documents | BAMFORM-URD-001 Rev 1.0 · BAMFORM-TST-001 Rev 0.1 |
| Trigger | Client confirmation (24 Jul 2026) that **ISO 13485** applies alongside ISO 9001 — OI-01 |

### Revision History

| Revision | Date | Details of revision | Revised by | Approved by |
|---|---|---|---|---|
| 0.1 | 24 Jul 2026 | Initial draft, created on resolution of OI-01 to ISO 9001 + ISO 13485 | Lead Engineer | _(pending)_ |

---

# 1. Purpose and Regulatory Basis

ISO 13485:2016 clause **4.1.6** requires the organisation to document procedures for the
validation of the application of computer software used in the quality management system, that
such software be **validated prior to initial use**, and revalidated after changes, with the
approach **proportionate to the risk** associated with the software's use.

BamForm holds the objective evidence that equipment used in production is maintained
(clause 6.3 infrastructure records, clause 4.2.5 control of records). It is therefore QMS
software and falls squarely within 4.1.6. This plan defines how BamForm will be validated,
who approves what, and what evidence exists at the end.

**Open dependency.** If any equipment produces product sold into the US under FDA regulation,
21 CFR Part 11 applies additionally. The client has not yet answered. This plan is written for
ISO 13485 without Part 11; §9 states exactly what changes if the answer is yes.

# 2. Approach and Proportionality

Clause 4.1.6 permits a risk-proportionate approach. The validation effort below is
concentrated where a software failure could compromise the maintenance record — record
integrity, signatures, offline capture, scheduling — and is lighter on low-risk functions
such as report formatting.

The V-model, mapped to documents that already exist:

| Specification side | Verification side |
|---|---|
| User requirements — BAMFORM-URD-001 | **PQ** — performance qualification against user requirements, in the production environment, by client users |
| Product/functional requirements — BAMFORM-PRD-001 | **OQ** — operational qualification against product requirements, in staging |
| Design — DBD, API, WFD, SEC | Verified by the automated suites in BAMFORM-TST-001 |
| Installation — ENV, RUN, compose | **IQ** — installation qualification on the target host |

This means the CI pipeline **is** design-level verification evidence: its committed test
definitions, gate thresholds and archived run outputs are validation records, not merely
engineering hygiene. What ISO 13485 adds is the formal IQ/OQ/PQ layer with named approvers,
pre-approved protocols, and controlled evidence.

# 3. Software Risk Assessment

| Function | Failure mode | Effect on QMS | Risk | Validation depth |
|---|---|---|---|---|
| Record capture (offline) | Completed record lost | Maintenance performed but no evidence — nonconformity | **High** | Full OQ scripts + the 16-case offline gate (TST §8) executed as protocol |
| Signature and integrity | Record altered undetectably; signature unattributable | Falsified quality records | **High** | OQ scripts + S-10/S-11 executed as protocol + golden-hash evidence |
| Scheduling and cascade | Job silently not generated | PM not performed; compliance gap found at audit | **High** | OQ scripts on cascade (U-CAS as protocol) + PR-RUN-16 monitoring qualified |
| Template revision control | Wrong revision in force; gap in sequence | Documented-information nonconformity (7.5) | **High** | OQ scripts + TLP verified load |
| Approval workflow | Self-approval; wrong role approves | Invalid verification | **High** | OQ scripts + S-22/S-24 as protocol |
| Archive retention | Record purged or unreadable | Loss of records within retention | **High** | Restore battery RV-1..7 executed as protocol |
| Notifications | Reminder not delivered | Delay, caught by overdue reporting | Medium | OQ smoke script |
| Reporting/trending | Wrong figure displayed | Misleading, correctable | Medium | OQ spot checks against known data |
| UI cosmetics | Layout defect | None on record validity | Low | Covered by automated E2E only |

# 4. Deliverables

| # | Deliverable | Number | Author | Approver |
|---|---|---|---|---|
| 1 | This validation plan | BAMFORM-VAL-001 | Lead Engineer | **Client Quality** |
| 2 | IQ protocol (pre-approved before execution) | BAMFORM-IQ-001 | Lead Engineer | Client Quality |
| 3 | IQ executed report | BAMFORM-IQ-001-R | Executor | Client Quality |
| 4 | OQ protocol | BAMFORM-OQ-001 | Lead Engineer | Client Quality |
| 5 | OQ executed report | BAMFORM-OQ-001-R | Executor | Client Quality |
| 6 | PQ protocol | BAMFORM-PQ-001 | Lead Engineer + client users | Client Quality |
| 7 | PQ executed report | BAMFORM-PQ-001-R | Client users | Client Quality |
| 8 | Requirements-to-evidence traceability matrix | BAMFORM-VAL-002 | Lead Engineer | Client Quality |
| 9 | Validation summary report and release statement | BAMFORM-VAL-003 | Lead Engineer | **Client Quality — this is the "validated prior to initial use" gate** |

**Protocols are approved before execution.** Executing an unapproved protocol and approving it
retrospectively is the classic validation finding; the sequencing here is deliberate.

# 5. Qualification Scope

## 5.1 IQ — Installation Qualification (target host, after recon)

Verifies the installed environment matches BAMFORM-ENV-001: host meets §2.1 minimums; NTP
synchronised (PR-ENV-02); correct image digests; all `bamform-*` services healthy; data
services publish no host port; volumes present; secrets present with mode 0400 and under
separate backup custody; TLS 1.3 serving at `form.bevorasg.com`; deploy cron installed under
`flock`; logrotate configured; **all pre-existing applications on the host unaffected**
(evidence per RUN §3.3).

## 5.2 OQ — Operational Qualification (staging)

Executes, as signed scripts with recorded actual results, the high-risk rows of §3. Each OQ
script cites the automated test it formalises (e.g. OQ-07 executes offline scenario O-01 with
a witnessed device in aeroplane mode). Includes challenge tests: attempt self-approval, attempt
edit of an archived record, attempt audit-row update as the app role, restore drill with
RV-1..7.

## 5.3 PQ — Performance Qualification (production, before go-live)

Client users execute the seven URD §5 journeys against the production installation with the
verified template load (TLP) and real asset register, including the five-minute completion
target (P-05) measured with a real technician in the cleanroom. PQ maps 1:1 to the 18
acceptance criteria; UAT (TST §14) and PQ are the same event, formalised.

# 6. Change Control and Revalidation

After initial validation, every change deploys only through the CI pipeline (design-level
regression evidence). Revalidation scope is risk-based:

| Change class | Examples | Revalidation |
|---|---|---|
| High-risk function change | Signing, sync, scheduling, approval logic, schema affecting records | Affected OQ scripts re-executed and re-approved |
| New function | New report, new notification | New OQ script |
| Low-risk change | UI text, styling, non-record queries | CI pipeline evidence suffices; recorded as such |
| Infrastructure change | Image digest bump, host move | IQ re-executed (delta) |

The classification of each release is recorded and approved by client Quality. **The annual
restore drill (PR-RUN-19) is a standing revalidation activity.**

# 7. Impact on Baseline Documents

To be revised at next issue: URD (AS-01, UR-102/106 now cite 13485 4.1.6, 4.2.5, 6.3), PRD
(§11.4 resolved, §14.2 effort +5–6 weeks → ~40, MFA moves into R1), SEC (§13.4 activated,
RS-3 withdrawn — MFA is now in scope), TST (adds §19 mapping suites to OQ scripts). Retention:
clause 4.2.5 ties record retention to the lifetime of the medical device — **client to confirm
whether this exceeds the assumed 7 years (OI-03 reopened).**

# 8. Roles

| Role | Validation responsibility |
|---|---|
| Client Quality | Approves this plan, all protocols, all executed reports, and the release statement. **Owns the decision that BamForm is validated for use** |
| Client users (technician, TL, engineer, doc controller) | Execute PQ |
| Lead Engineer | Authors protocols, executes IQ/OQ, maintains traceability, may not approve own work |
| IT / host owner | Witnesses IQ items concerning the shared host |

# 9. If 21 CFR Part 11 Applies (pending client answer)

Additions, none structural: MFA mandatory (already moved to R1 under 13485); per-user signature
meaning statement captured at enrolment and displayed at each signing (extends PR-096); systems
documentation controls; validation documentation retained per predicate-rule retention;
operational system checks enforcing sequencing. Estimated +2 weeks beyond the 13485 uplift.

---

## Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Client Quality (approver of this plan) | ____________________ | ____________________ | ________ |
| Client sign-off authority | ____________________ | ____________________ | ________ |
| Lead Engineer | ____________________ | ____________________ | ________ |

*End of document — BAMFORM-VAL-001 Revision 0.1*
