# User Requirement Document
## BamForm — Preventive Maintenance Record and Approval System

---

## Document Control

| Field | Value |
|---|---|
| Document title | User Requirement Document — BamForm Preventive Maintenance Record and Approval System |
| Document number | BAMFORM-URD-001 |
| Revision | 1.0 |
| Status | **Approved** |
| Date issued | 23 July 2026 |
| Date approved | 23 July 2026 |
| Prepared by | Lead Engineer, BamForm project |
| Reviewed by | _(to be completed)_ |
| Approved by | _(to be completed — client sign-off authority)_ |
| Classification | Internal |
| Distribution | Project sponsor, Maintenance Department, Quality / Document Control |
| Related repository | `git@github.com:Mavrone81/bamform.git` |
| Target service URL | `https://form.bevorasg.com` |

### Revision History

| Revision | Date | Details of revision | Revised by | Approved by |
|---|---|---|---|---|
| 0.1 | 23 Jul 2026 | Initial draft derived from twelve source preventive maintenance records and client answers to Phase 0 blocking questions | Lead Engineer | _(pending)_ |
| 1.0 | 23 Jul 2026 | Approved by client without amendment. Open issues OI-01 to OI-08 remain outstanding and are carried forward into the PRD as flagged assumptions. | Lead Engineer | Client sign-off authority |

### Approval

This document requires written approval before Phase 2 (Product Requirement Document)
commences. See Section 9.

---

## Table of Contents

1. Introduction
2. Stakeholders and User Personas
3. Functional Requirements
4. Non-Functional Requirements
5. User Journeys
6. Assumptions, Constraints and Dependencies
7. Acceptance Criteria
8. Open Issues Requiring Client Decision
9. Sign-Off

---

# 1. Introduction

## 1.1 Purpose

This document states, in business language, what the BamForm system must do. It is the
basis for client sign-off. It deliberately contains no implementation detail; technology
selection, data design and system architecture are addressed in the Product Requirement
Document (BAMFORM-PRD-001), which will be written only after this document is approved.

Every requirement in Section 3 and Section 4 carries a unique identifier (`UR-xxx`). Each
will be traced forward to one or more product requirements in the PRD and to one or more
test cases in the Test Plan.

## 1.2 Background

The Maintenance Department currently records preventive maintenance (PM) activity on
Microsoft Excel worksheets that are printed, completed by hand, wet-signed by up to three
people, and filed. Twelve such controlled documents were supplied as the basis for this
specification (Section 1.6).

Analysis of the supplied files identified the following weaknesses in the current process,
which the system is intended to remove:

| Ref | Observation in supplied files | Business consequence |
|---|---|---|
| B-01 | Broken formula references (`#REF!` in `CE 95 010 00 01`, `#VALUE!` in `CE 95 043 00 01`) | Controlled documents display errors in their header block, undermining document integrity |
| B-02 | Revision sequence 0, A, C, D, E in `CE 95 010 00 01` — revision B absent | Revision history is not demonstrably complete to an auditor |
| B-03 | Revision history of `CE 95 055 00 01` is not in chronological order | Cannot establish which revision was current on a given date |
| B-04 | Specification limit recorded as "95 – 28 g" in `CE 95 020 00 01` | An impossible tolerance survived three revisions and two approvers; no validation exists to catch it |
| B-05 | Approver identity recorded inconsistently ("Sara" / "Saravanan Durairaj"; "Suren" / "Surendran Ganesan") | Signatory cannot be unambiguously identified |
| B-06 | A worksheet in `CE 95 020 00 03` still carries the tab name of `CE 95 020 00 01` | Evidence of copy-paste document creation without controlled review |
| B-07 | No input validation of any kind exists in any supplied workbook | Any value, or no value, can be entered in any field |
| B-08 | Signatures are printed blank lines completed by hand | No timestamp, no verifiable signatory identity, no tamper evidence after signing |
| B-09 | Machine identity is a blank to be handwritten (`ED____`, `EW_____`, `KW___`, `MB_____`, `DP_____`, `IMOS 0__`, `AVS 35-____`) | Maintenance history cannot be reliably assembled for an individual machine |

## 1.3 Scope

BamForm is a web-based system, usable on mobile devices on the shop floor, that will:

- hold a register of equipment assets;
- hold version-controlled preventive maintenance form templates;
- generate maintenance jobs automatically from each asset's maintenance frequency;
- allow a maintenance technician to complete the job record on a mobile device, including
  where network connectivity is unavailable;
- route the completed record for verification and approval;
- archive the approved record in an unalterable form; and
- provide search, reporting and audit access over the archive.

## 1.4 Out of Scope

The following are explicitly **not** in scope for this system and will not be delivered
unless separately agreed in writing:

- **OS-01** Corrective maintenance, breakdown work orders and repair job management.
- **OS-02** Spare parts inventory management, stock levels, reorder points and purchasing.
  Parts consumed during a PM job are *recorded* (UR-034) but stock is not maintained.
- **OS-03** Financial costing of maintenance labour or parts.
- **OS-04** Integration with any existing ERP, CMMS or asset management system. To be
  reconsidered at Phase 2 (client answer to Phase 0 question 6).
- **OS-05** Machine condition monitoring, sensor telemetry, IoT data capture or predictive
  maintenance analytics.
- **OS-06** Calibration certificate management and external calibration body workflow.
- **OS-07** Training records, competency matrices and technician certification tracking.
- **OS-08** General-purpose form design by end users. Form templates are authored by
  designated document-control personnel using a structured editor (UR-013); this system is
  not a free-form form builder.
- **OS-09** Replacement of the organisation's wider document management system for
  non-maintenance documents.

## 1.5 Definitions

| Term | Definition |
|---|---|
| **Asset type** | A class of equipment sharing one maintenance form template, e.g. "ASM Wire Bond" |
| **Asset** | An individual physical machine, uniquely identified, e.g. `AW03` |
| **Form template** | A controlled document defining the maintenance checklist for an asset type |
| **Template revision** | An issued, approved version of a form template, identified by a revision code (0, A, B, C…) |
| **Checklist item** | A single numbered maintenance instruction within a template, carrying a frequency |
| **Measurement item** | A checklist item that requires a numeric or Pass/Fail reading against a stated specification |
| **Frequency** | The maintenance interval of an item: Monthly (1M), Three Monthly (3M), Six Monthly (6M), Yearly (Y) |
| **Job** | An instance of maintenance due on one asset at one point in time |
| **Record** | The completed job, including all item results, signatures and dates |
| **Maintainer** | The technician who performs the maintenance and completes the record |
| **Verifier** | The Team Leader or Engineer who checks and approves the record |
| **Archive** | The store of approved records, held unaltered for the retention period |
| **PM** | Preventive Maintenance |
| **DMS** | Document Management System |

## 1.6 Source Documents

The following controlled documents were supplied and analysed. They form the initial
content of the system and the basis of the requirements below.

| Document number | Title | Rev. | Checklist items | Measurement section |
|---|---|---|---|---|
| CE 95 010 00 01 | BESI Die Attach Preventive Maintenance Record `ED____` | E | 18 | Inline curing oven, Pass/Fail |
| CE 95 012 00 01 | Preventive Maintenance Record `EP01` (Emerald Pick and Place) | 0 | 6 | — |
| CE 95 012 00 02 | Preventive Maintenance Record `PM01` (Powatec Mounting) | 0 | 4 | — |
| CE 95 020 00 01 | ASM Wire Bond Preventive Maintenance Record | C | 14 | Full calibration table, 21 measurements |
| CE 95 020 00 02 | Besi Esec Wire Bond Preventive Maintenance Record `EW_____` | C | 15 | Calibration table |
| CE 95 020 00 03 | KNS Wire Bond Preventive Maintenance Record `KW___` | B | 15 | Calibration table |
| CE 95 030 00 01 | MB Encapsulation Preventive Maintenance Record `MB_____` | D | 13 | — |
| CE 95 030 00 03 | Pre-mixer machine Preventive Maintenance Record `DP_____` | 0 | 9 | Resin tank seal test, LCL/UCL |
| CE 95 043 00 01 | Bump Dispensing Preventive Maintenance WI and Record | 0 | 18 | — |
| CE 95 050 00 01 | MB E-Test Preventive Maintenance Record | D | 10 | — |
| CE 95 050 00 03 | OS Loading Preventive Maintenance Record `IMOS 0__` | 0 | 10 | — |
| CE 95 055 00 01 | Preventive Maintenance Work Instruction / Record `AVS 35-____` | A | 13 | — |

**Total: 12 templates, 145 checklist items.**

---

# 2. Stakeholders and User Personas

## 2.1 Stakeholder Register

| Stakeholder | Interest in the system | Involvement |
|---|---|---|
| Project sponsor / client sign-off authority | Approves requirements, funds delivery, owns the outcome | Approves this document and each subsequent phase |
| Maintenance Department management | Compliance rate visibility, workload planning | Consulted; primary report consumer |
| Maintenance technicians | Daily users; complete records on the shop floor | Primary users; must be consulted on usability |
| Workshop Team Leaders | Verify completed records | Approvers |
| Maintenance / Manufacturing Engineers | Verify completed records; author and revise templates | Approvers and template authors |
| Quality / Document Control | Document revision integrity, audit readiness, retention | Governs template approval and archive rules |
| Internal and external ISO auditors | Evidence that PM was performed as specified | Read-only consumers of the archive |
| IT / Infrastructure | Hosting, backup, security of the `165` server | Provides access and operational support |

## 2.2 User Personas

### P1 — Maintenance Technician ("Maintainer")
Performs the maintenance. Works at the machine, often in a cleanroom, wearing gloves,
frequently with the machine powered down and locked out. May have poor or no network
signal at the machine. Uses a phone or tablet, one-handed, sometimes standing. Has limited
patience for software. **Needs:** the checklist for today's job, in order, with large
touch targets; the ability to record results without connectivity; a way to add a photo or
a remark; and a submit action that clearly confirms the job is filed.

### P2 — Workshop Team Leader ("Verifier")
Checks that the work was done and the record is complete before approving. Reviews several
records at once, typically at a desk, sometimes on a phone. **Needs:** a queue of records
awaiting their approval; a clear view of what was recorded, including anything the
technician flagged; the ability to approve, or to return the record to the technician with
a reason.

### P3 — Maintenance Engineer / Supervisor
Acts as an alternative verifier to the Team Leader, and additionally authors and revises
form templates. **Needs:** everything P2 needs, plus the ability to create a new template
revision, edit checklist items and specifications, and submit that revision for approval.

### P4 — Document Controller / Quality
Owns the integrity of the controlled documents and the archive. Approves new template
revisions and issues them. **Needs:** control over which template revision is current;
assurance that a record can never be altered after approval; confidence that every record
states the template revision it was performed against; and the ability to produce, on
demand, evidence for an audit.

### P5 — System Administrator
Manages users, roles, assets and system configuration. **Needs:** to create and deactivate
users, assign roles, create asset types and assets, and set maintenance schedules, without
developer assistance.

### P6 — Auditor (read-only)
Internal or external. Arrives with specific questions: "show me the PM history of machine
AW03 for the last two years", "show me the checklist that was in force in March 2026",
"prove this record has not been changed since it was signed". **Needs:** unrestricted
read access to the archive and the audit trail, and no ability to change anything.

### P7 — Delegated Approver
A verifier acting temporarily in place of another during absence. Sees the absent person's
approval queue for a defined period, and every action they take is recorded as having been
taken by them on behalf of the absent approver.

---

# 3. Functional Requirements

Priority: **M** = Must have (Release 1) · **S** = Should have (Release 1 if capacity) ·
**C** = Could have (later release).

## 3.1 Asset Register

| ID | Requirement | Priority |
|---|---|---|
| UR-001 | The system shall hold a register of **asset types**, each representing a class of equipment governed by one maintenance form template. | M |
| UR-002 | The system shall hold a register of individual **assets** (physical machines), each belonging to exactly one asset type. | M |
| UR-003 | Each asset shall carry a unique identifier following the organisation's existing convention (for example `AW01`, `BD01`, `EP01`, `IMOS 01`, `AVS 35-01`). The system shall reject a duplicate identifier. | M |
| UR-004 | An authorised user shall be able to create, edit and deactivate asset types and assets through the user interface, without developer involvement. | M |
| UR-005 | Each asset shall record, at minimum: identifier, asset type, description, manufacturer, model, location/area, commissioning date, and status (active / under repair / decommissioned). | M |
| UR-006 | Deactivating an asset shall stop future maintenance jobs being generated for it, and shall not delete or hide any historical record relating to it. | M |
| UR-007 | The system shall display, for any asset, its complete maintenance history in date order, with each record openable. | M |
| UR-008 | The system shall support assets being added over time without configuration change or redeployment. | M |

## 3.2 Form Templates and Document Control

| ID | Requirement | Priority |
|---|---|---|
| UR-009 | The system shall hold **form templates**, each identified by a document number in the organisation's existing format (e.g. `CE 95 020 00 01`) and a document title. | M |
| UR-010 | Each template shall be **revision controlled**. Revisions shall be identified by the organisation's existing sequence (0, A, B, C, …) and the system shall enforce that the sequence is contiguous, preventing the gap observed in B-02. | M |
| UR-011 | Each template revision shall record the date of issue, the person who authored the revision, the person who approved it, and a description of what changed — reproducing the content of the existing Revision History sheet. | M |
| UR-012 | Exactly one revision of a template shall be **current** at any time. Issuing a new revision shall supersede the previous one; the superseded revision shall be retained and remain viewable. | M |
| UR-013 | An authorised user (P3, P4) shall be able to create a new draft revision of a template through a structured editor, and edit its checklist items, frequencies, specifications, safety notes, PPE list, tools and parts. | M |
| UR-014 | A new template revision shall not become current until it has been approved by an authorised approver. A user shall not be able to approve their own template revision. | M |
| UR-015 | Each template shall define its checklist items, each with: item number, frequency (1M / 3M / 6M / Y) and instruction text. | M |
| UR-016 | A template shall optionally define **measurement items**, each with: section, description, specification (expressed as a numeric range, a tolerance, or a Pass/Fail judgement) and unit. | M |
| UR-017 | Each template shall carry its standing content: Special Tools Required, Parts Required table, PPE Required list, Safety statement, Procedure/Note statement, and Remarks. | M |
| UR-018 | The system shall support a template covering multiple machines on one sheet, as `CE 95 020 00 01` does for AW01–AW04, while still producing a separate record per machine. | M |
| UR-019 | The system shall validate specification limits on entry — a lower limit above an upper limit shall be rejected, preventing the defect recorded in B-04. | M |
| UR-020 | The system shall allow a new asset type and its template to be created for equipment not among the twelve supplied documents. | M |
| UR-021 | The twelve supplied documents shall be loaded into the system at their current revision as part of delivery, with content verified against the source files by the client. | M |

## 3.3 Maintenance Scheduling

| ID | Requirement | Priority |
|---|---|---|
| UR-022 | The system shall automatically generate a maintenance **job** for an asset when maintenance falls due, without any user needing to initiate it. | M |
| UR-023 | Each asset shall have a maintenance schedule derived from the frequencies defined in its template (1M, 3M, 6M, Y). | M |
| UR-024 | The system shall apply the **cumulative frequency rule** stated on every supplied document — a Yearly job shall include all 3M, 6M and Y items; a 6M job shall include all 3M and 6M items; and where a template defines 1M items, the rule shall follow that template's own Remarks statement. | M |
| UR-025 | An authorised user shall be able to set, for each asset, the reference date from which its schedule is calculated, and to adjust the next due date with a recorded reason. | M |
| UR-026 | The system shall present a maintenance calendar and a due/overdue list, filterable by asset, asset type, area and date range. | M |
| UR-027 | A job shall be generated a configurable period in advance of its due date, so that the pre-work stated in the templates (inspection one month ahead, sourcing parts, requesting machine downtime) can be performed. | M |
| UR-028 | An authorised user shall be able to raise an **ad-hoc job** against an asset outside the schedule, with a recorded reason. | S |
| UR-029 | A job shall be assignable to a named technician, and reassignable, with the change recorded. | M |
| UR-030 | Where a job is not completed by its due date, the system shall mark it overdue and notify the assignee and their Team Leader. | M |

## 3.4 Record Completion

| ID | Requirement | Priority |
|---|---|---|
| UR-031 | A technician shall be able to open an assigned job on a mobile device and see the checklist items applicable to that job's frequency, in item-number order, together with the safety statement, PPE list and tools required. | M |
| UR-032 | The technician shall be able to record a status against each checklist item. | M |
| UR-033 | Where the template defines measurement items, the technician shall be able to record a reading against each, and shall be shown the applicable specification while doing so. | M |
| UR-034 | The technician shall be able to record parts consumed (part number, description, quantity, remarks), matching the Parts Required table on the paper form. | M |
| UR-035 | The technician shall be able to add a free-text remark against any item and against the job as a whole. | M |
| UR-036 | The technician shall be able to attach photographs to an item or to the job. | S |
| UR-037 | The system shall record the identity of the technician and the date and time of completion automatically. The record shall not depend on a handwritten name, removing defect B-05. | M |
| UR-038 | The system shall permit a job to be completed **without network connectivity**, holding the entries on the device and transmitting them automatically when connectivity returns. The technician shall be able to see clearly whether their work has been transmitted. | M |
| UR-039 | The system shall prevent submission of a record in which mandatory items have not been completed, and shall show the technician which items remain. | M |
| UR-040 | A record shall be permanently bound to the template revision that was current when the job was raised. A subsequent template revision shall not alter any existing record. | M |
| UR-041 | A record shall be permanently bound to the asset it was performed on, removing the handwritten machine identifier defect B-09. | M |
| UR-042 | A partially completed record shall be saved as a draft and be resumable by the same technician. | M |

## 3.5 Approval Workflow

The approval route confirmed by the client is:

**Maintainer completes → Team Leader *or* Engineer verifies → Record is archived.**

| ID | Requirement | Priority |
|---|---|---|
| UR-043 | On submission by the maintainer, the record shall be routed automatically to the verification stage without any manual forwarding. | M |
| UR-044 | The verification stage shall be satisfiable by **either** an authorised Workshop Team Leader **or** an authorised Engineer. | M |
| UR-045 | A user shall not be able to verify a record they completed themselves. | M |
| UR-046 | On verification, the record shall move automatically to the archive and become unalterable. | M |
| UR-047 | A verifier shall be able to **return** a record to the maintainer with a mandatory reason. A returned record shall become editable by the maintainer and shall re-enter the workflow on resubmission. | M |
| UR-048 | Each approval action shall capture the approver's identity, the date and time, and the exact content approved, in a manner that allows later demonstration that the content has not changed since approval. | M |
| UR-049 | A verifier shall see a queue of records awaiting their action, ordered by age, with overdue items distinguished. | M |
| UR-050 | Where a record remains unverified beyond a configurable period, the system shall escalate by notification to a nominated recipient. | M |
| UR-051 | A maintainer shall be able to **recall** a submitted record before it has been verified. | S |
| UR-052 | An approver shall be able to nominate a **delegate** for a defined date range. The delegate shall see the delegating approver's queue, and every action shall be recorded as performed by the delegate on behalf of the approver. | S |
| UR-053 | The approval route shall be configurable per asset type, so that a different number or sequence of approval stages can be applied in future without software change. | S |
| UR-054 | The system shall never permit a record to be deleted at any stage. Records raised in error shall be voided with a mandatory reason, and remain visible as voided. | M |

## 3.6 Archive and Retrieval

| ID | Requirement | Priority |
|---|---|---|
| UR-055 | Approved records shall be held in an archive from which they cannot be edited or removed by any user, including administrators. | M |
| UR-056 | The system shall render any record as a document that reproduces the layout, header block, document number, revision, checklist and signature block of the corresponding controlled paper form, suitable for printing or issue to an auditor. | M |
| UR-057 | The rendered document shall display, for each signature, the signatory's full name, role and the date and time of signing. | M |
| UR-058 | Users shall be able to search and filter the archive by asset, asset type, document number, frequency, date range, technician and approver. | M |
| UR-059 | Users shall be able to export a selected set of records for external filing in the organisation's document management system. | M |
| UR-060 | Records shall be retained for the full retention period defined in Section 4.5 and shall not be automatically purged. | M |

## 3.7 Notification

| ID | Requirement | Priority |
|---|---|---|
| UR-061 | The system shall notify a technician when a job is assigned to them. | M |
| UR-062 | The system shall notify a technician and their Team Leader when a job is approaching its due date and when it becomes overdue. | M |
| UR-063 | The system shall notify verifiers when a record enters their queue. | M |
| UR-064 | The system shall notify a maintainer when their record is verified, and when it is returned. | M |
| UR-065 | Notification recipients, thresholds and channels shall be configurable by an administrator. | S |
| UR-066 | Each user shall be able to control which notifications they receive. | C |

## 3.8 Reporting

| ID | Requirement | Priority |
|---|---|---|
| UR-067 | The system shall report **PM compliance** — jobs due against jobs completed on time — by period, area and asset type. | M |
| UR-068 | The system shall report jobs currently overdue and records currently awaiting verification, with ageing. | M |
| UR-069 | The system shall produce, for any asset, a complete maintenance history suitable for presentation to an auditor. | M |
| UR-070 | The system shall present recorded measurement readings for an asset over time, so that drift against specification is visible. | S |
| UR-071 | Reports shall be exportable to a spreadsheet format. | S |

## 3.9 Administration and Access

| ID | Requirement | Priority |
|---|---|---|
| UR-072 | An administrator shall be able to create, edit and deactivate users, and assign roles. | M |
| UR-073 | The system shall implement the roles: Maintainer, Team Leader, Engineer, Document Controller, Administrator, Auditor (read-only). A user may hold more than one role. | M |
| UR-074 | A user's permissions shall be enforced by the system on every action, and shall not depend on the user interface concealing an option. | M |
| UR-075 | A user account shall be deactivated rather than deleted, and all historical records naming that user shall remain intact and attributable. | M |
| UR-076 | The system shall maintain an **audit trail** of every action affecting a record, a template or an asset: who, what, when, previous value, new value, and originating device or address. | M |
| UR-077 | The audit trail shall itself be unalterable, and it shall be possible to demonstrate that it has not been tampered with. | M |
| UR-078 | The audit trail shall be viewable and searchable by the Auditor and Document Controller roles. | M |

---

# 4. Non-Functional Requirements

## 4.1 Usability and Accessibility

| ID | Requirement |
|---|---|
| UR-079 | The system shall be fully usable on a mobile phone at 375 px width, without horizontal scrolling on any page. |
| UR-080 | All interactive controls shall present a touch target of at least 44 × 44 px, usable while wearing gloves. |
| UR-081 | The system shall be usable on phone (375 px), tablet (768 px) and desktop (1280 px). |
| UR-082 | A technician shall be able to complete a typical 14-item checklist in under five minutes of interaction. |
| UR-083 | The user interface shall be in English. |
| UR-084 | The system shall meet WCAG 2.1 Level AA, including colour contrast sufficient for use under shop-floor lighting. |
| UR-085 | No user shall require more than 30 minutes of training to complete and submit a maintenance record. |

## 4.2 Availability and Performance

| ID | Requirement |
|---|---|
| UR-086 | The system shall be available 99.5 % of the time during the working week, excluding notified maintenance windows. |
| UR-087 | Any page shall load within 2 seconds on the site network, and within 5 seconds on a 4G mobile connection. |
| UR-088 | Record completion shall function fully offline; queued records shall transmit within 60 seconds of connectivity returning. |
| UR-089 | The system shall support at least 100 named users and 50 concurrent users without degradation, sized against the client's answer to the asset-count question (Section 8, OI-02). |
| UR-090 | Scheduled maintenance of the system shall not take the service down during shift hours without prior notice. |

## 4.3 Security

| ID | Requirement |
|---|---|
| UR-091 | All access shall require individual authentication. Shared or generic accounts shall not be permitted, as the integrity of every signature depends on individual identity. |
| UR-092 | All data in transit shall be encrypted using current strong transport encryption. |
| UR-093 | Personal data held by the system (name, employee identifier, contact details) shall be encrypted at rest. |
| UR-094 | The organisation's data shall be encrypted at rest at the storage layer in addition to the above. |
| UR-095 | Authentication credentials shall be stored in a form from which the original cannot be recovered. |
| UR-096 | Repeated failed authentication attempts shall be rate-limited and result in temporary lockout. |
| UR-097 | A user session shall expire after a period of inactivity and require re-authentication. |
| UR-098 | An approval action shall require the approver to be actively authenticated at the moment of approval. |
| UR-099 | The system shall be protected against unauthorised access to records belonging to areas or roles the user is not entitled to see. |
| UR-100 | The system shall comply with the Personal Data Protection Act in respect of the employee personal data it holds. |
| UR-101 | Security-relevant events (failed logins, permission changes, role changes, template approvals) shall be logged and retained. |

## 4.4 Compliance

| ID | Requirement |
|---|---|
| UR-102 | The system shall satisfy the requirements of ISO 9001 clause 7.5 (documented information) in respect of the records it holds: identification, review and approval, version control, controlled distribution, protection from unintended alteration, and defined retention. |
| UR-103 | The system shall satisfy ISO 9001 clause 7.1.3 in respect of evidence that infrastructure is maintained to plan. |
| UR-104 | An approved record shall constitute objective evidence acceptable to an auditor that the stated maintenance was performed on the stated asset, on the stated date, by the stated person, and verified by the stated approver. |
| UR-105 | The system shall be able to demonstrate, for any record, which template revision was in force at the time it was performed, and to display that revision's content. |
| UR-106 | Where the client confirms an additional regime applies (Section 8, OI-01), the electronic signature and record-retention requirements of that regime shall be met. |

## 4.5 Retention, Backup and Continuity

| ID | Requirement |
|---|---|
| UR-107 | Approved records shall be retained for a minimum of **seven years** unless the client specifies otherwise (Section 8, OI-03). |
| UR-108 | Superseded template revisions shall be retained for the same period as the last record that references them. |
| UR-109 | The system shall be backed up daily, with backups held separately from the running system. |
| UR-110 | It shall be possible to restore the system to a working state within **4 hours** of a failure, losing no more than **24 hours** of data. |
| UR-111 | The restore procedure shall be tested and the test evidenced before the system is accepted. |
| UR-112 | Records shall be exportable in a format that remains readable independently of this system, so that the organisation is not locked in. |

## 4.6 Operational

| ID | Requirement |
|---|---|
| UR-113 | The system shall run on the client's existing `165` server alongside the applications already hosted there, and shall not disturb them. |
| UR-114 | The system shall be reachable at `https://form.bevorasg.com`. |
| UR-115 | Updates shall be deployed without manual intervention on the server and without data loss. |
| UR-116 | The system shall provide a health indication that allows operational staff to confirm it is running correctly. |

---

# 5. User Journeys

## 5.1 Journey A — Maintainer completes a scheduled PM

1. Monday morning, the technician opens BamForm on their phone and sees three jobs
   assigned to them, one flagged as due this week: *3M PM — AW03 — ASM Wire Bond*.
2. They open the job. The header shows the machine, the document number `CE 95 020 00 01`,
   revision C, and the frequency. The safety statement and PPE list are shown before the
   checklist.
3. They walk to the machine, which is in a cleanroom with no signal. The job is already
   held on the device.
4. They lock out the machine, then work down the 14 items, recording a status against each.
   On item 12 they note the air filter needed replacing and record the part consumed.
5. They reach the calibration section and record 21 readings. Each field shows its
   specification beside it.
6. They photograph the heater block.
7. They submit. The device shows the record is held and will be sent when signal returns.
8. Leaving the cleanroom, the record transmits. The technician gets a confirmation, and the
   Team Leader is notified.

## 5.2 Journey B — Verifier approves

1. The Team Leader opens their queue and sees four records awaiting verification, the
   oldest two days old.
2. They open the AW03 record. It shows every item, every reading, the technician's remark
   about the air filter, the photograph, and the technician's name and completion time.
3. They approve. The record is signed with their name, role and timestamp, and moves to the
   archive.
4. The technician is notified that the record has been verified.

## 5.3 Journey C — Verifier returns a record

1. Reviewing a second record, the Team Leader sees that item 9 has been left blank and the
   remark contradicts the status recorded on item 4.
2. They select Return, and enter the reason: *"Item 9 not completed; item 4 remark
   inconsistent with status — please confirm."*
3. The technician is notified, opens the returned record, corrects it, and resubmits.
4. The record re-enters the queue. The archive later shows the full sequence: submitted,
   returned with reason, resubmitted, verified — all timestamped.

## 5.4 Journey D — Delegated approver covers an absence

1. The Team Leader will be on leave for two weeks. Before leaving, they nominate an
   Engineer as delegate for those dates.
2. During the absence, the Engineer sees both their own queue and the Team Leader's.
3. They verify a record. The archive records: *verified by [Engineer], acting as delegate
   for [Team Leader]*, with the timestamp.
4. On the end date the delegation lapses automatically.

## 5.5 Journey E — Engineer revises a template

1. A new inspection step is required on the Besi Die Attach machines.
2. The Engineer opens template `CE 95 010 00 01`, currently revision E, and creates a draft
   revision F.
3. They add the item, set its frequency to 3M, and enter the reason for the change.
4. They submit the revision for approval. They cannot approve it themselves.
5. The Document Controller reviews and approves it. Revision F becomes current; revision E
   is superseded and retained.
6. Jobs raised from that point use revision F. Records already completed against revision E
   are unaffected and still display revision E's checklist.

## 5.6 Journey F — Administrator adds a new machine

1. A new wire bonder, `AW05`, is commissioned.
2. The Administrator opens the asset register, selects asset type *ASM Wire Bond*, and
   creates asset `AW05` with its location and commissioning date.
3. They set the schedule reference date.
4. The system begins generating 3M, 6M and Y jobs for `AW05` automatically. No software
   change was required.

## 5.7 Journey G — Auditor reviews evidence

1. An ISO auditor asks for the PM history of `AW03` for the past two years.
2. The Auditor account filters the archive by asset and date range and produces 8 records.
3. The auditor asks to see the checklist as it stood in March 2026. The record from that
   date displays revision C, not the current revision.
4. The auditor asks how they can be sure the record has not been altered since signature.
   The system displays the signature detail and the audit trail for that record, showing
   every action taken on it and demonstrating the content is unchanged since approval.
5. The auditor asks for a printed copy. The record is rendered in the layout of the
   controlled form and printed.

---

# 6. Assumptions, Constraints and Dependencies

## 6.1 Assumptions

| ID | Assumption | Impact if wrong |
|---|---|---|
| AS-01 | The applicable regime is ISO 9001 only. No medical-device (ISO 13485 / 21 CFR Part 11) or automotive (IATF 16949) requirement applies. | Electronic signature and retention requirements would become substantially stricter; re-scoping required |
| AS-02 | Recording a checklist result does not branch the workflow. Measurement readings are captured for the record and for trend history, but an out-of-specification reading does not block submission and does not raise a non-conformance in Release 1. *(Per client answer. Note that four of the twelve supplied templates define Pass/Fail specification limits; the system will record and display them, and the ability to act on them can be added later without redesign.)* | If out-of-spec handling is required, an additional workflow branch and non-conformance entity are needed |
| AS-03 | Approval requires one verification stage, satisfiable by a Team Leader or an Engineer, followed by archiving. The two separate verification blocks printed on the supplied forms are superseded by this. | If both signatures are required, the route becomes two sequential stages; UR-053 makes this configurable |
| AS-04 | "Archive in DMS" means the approved record is held in BamForm's own archive and exported to the existing document management system. BamForm is not required to write directly into that system. | A DMS integration would be additional scope |
| AS-05 | All users are employees of one organisation at one site. The system is single-tenant. | Multi-site or multi-tenant operation would change the access model |
| AS-06 | Users have organisation-issued email addresses for notification. | An alternative notification channel would be needed |
| AS-07 | Technicians have access to a phone or tablet capable of running a modern browser. | Device procurement becomes a dependency |
| AS-08 | The content of the twelve supplied documents is current and correct at the revisions supplied, other than the defects listed in Section 1.2. | Loading incorrect content would compromise the archive from day one |
| AS-09 | Wi-Fi coverage on the shop floor is incomplete, hence the offline requirement. | If coverage is complete, offline capability could be reduced in scope |

## 6.2 Constraints

| ID | Constraint |
|---|---|
| CN-01 | The system must be hosted on the client's existing `165` server, which is live and shared with other applications. No unrelated application may be disturbed. |
| CN-02 | The public address is fixed as `https://form.bevorasg.com`. |
| CN-03 | The source repository is fixed as `git@github.com:Mavrone81/bamform.git`. |
| CN-04 | Document numbering, revision lettering and asset identifier conventions are set by existing practice and must be adopted, not replaced. |
| CN-05 | The system must not require changes to the organisation's existing document management system. |
| CN-06 | The system must operate in areas where network connectivity is unreliable. |

## 6.3 Dependencies

| ID | Dependency | Owner | Required by |
|---|---|---|---|
| DP-01 | Access credentials for the `165` server, and confirmation of whether it is production or staging | Client / IT | Before Phase 0 recon can complete |
| DP-02 | DNS for `form.bevorasg.com` pointing to the server | Client / IT | Before deployment |
| DP-03 | Confirmed list of assets and their identifiers | Client / Maintenance | Before go-live |
| DP-04 | Confirmed list of users, their roles and email addresses | Client | Before go-live |
| DP-05 | Verification by the client that loaded template content matches the source documents | Client / Document Control | Before go-live |
| DP-06 | Client decision on the open issues in Section 8 | Client | As stated per issue |
| DP-07 | Confirmation of the existing document management system and export format | Client | Phase 2 |

---

# 7. Acceptance Criteria

The system will be accepted when all of the following are demonstrated to the sign-off
authority:

| ID | Acceptance criterion | Traces to |
|---|---|---|
| AC-01 | All twelve supplied templates are loaded at their current revision, and the client confirms the checklist content of each matches the source document. | UR-021 |
| AC-02 | An administrator creates a new asset type, a new template and a new asset without developer assistance, and a job is generated for it. | UR-004, UR-020, UR-022 |
| AC-03 | A Yearly job on a wire bond asset presents the union of 3M, 6M and Y items, as the source document requires. | UR-024 |
| AC-04 | A technician completes a full record on a phone in aeroplane mode; the record transmits automatically on reconnection and appears in the verifier's queue. | UR-038, UR-043 |
| AC-05 | A technician cannot verify their own record. | UR-045 |
| AC-06 | A verifier returns a record with a reason; the technician corrects and resubmits; the archive shows the full sequence with timestamps. | UR-047 |
| AC-07 | An approved record cannot be edited or deleted by any user, including an administrator; the attempt is refused and logged. | UR-054, UR-055 |
| AC-08 | A record is rendered in the layout of the controlled paper form, showing document number, revision, checklist, readings and named signatures with timestamps. | UR-056, UR-057 |
| AC-09 | A template is revised and approved; new jobs use the new revision; an existing record still displays the revision it was performed against. | UR-012, UR-040, UR-105 |
| AC-10 | An auditor account produces the two-year history of a single asset and can view but not alter it. | UR-007, UR-069, UR-074 |
| AC-11 | The audit trail for a record is displayed and demonstrated to be tamper-evident. | UR-076, UR-077 |
| AC-12 | Every page is shown to display correctly with no horizontal scroll at 375 px, 768 px and 1280 px. | UR-079, UR-081 |
| AC-13 | Overdue jobs and pending verifications generate notifications and escalate as configured. | UR-030, UR-050, UR-062 |
| AC-14 | A backup is taken and restored to a separate environment with data integrity confirmed. | UR-109, UR-110, UR-111 |
| AC-15 | Personal data is shown to be encrypted at rest, and shown to be correctly readable through the application. | UR-093 |
| AC-16 | The system is shown running at `https://form.bevorasg.com` over a valid certificate, with every pre-existing application on the server confirmed still running. | UR-113, UR-114 |
| AC-17 | A deployment is performed and shown to take effect automatically, without data loss and without affecting other applications on the server. | UR-115 |
| AC-18 | The PM compliance report is produced for a chosen period and reconciles against the job records. | UR-067 |

---

# 8. Open Issues Requiring Client Decision

| ID | Issue | Why it matters | Needed by |
|---|---|---|---|
| OI-01 | **Confirm the regulatory regime is ISO 9001 only.** The client answered "ISO". If any of this equipment produces medical-device or automotive product, ISO 13485 or IATF 16949 may also apply, and electronic signature requirements would tighten considerably. | Drives UR-102 to UR-106 and the electronic signature design | Before PRD |
| OI-02 | **Confirm the asset count.** The client answered "3 assets × number of machines". This has been read as: asset *types* and asset *units* are both user-creatable and unbounded (UR-001 to UR-004). A best estimate of the number of physical machines is still needed for sizing. | Drives UR-089 and infrastructure sizing | Before PRD |
| OI-03 | **Confirm the record retention period.** Seven years has been assumed. | Drives UR-107 and storage sizing | Before PRD |
| OI-04 | **Confirm AS-03.** The supplied forms carry two verification signature blocks (Team Leader *and* Supervisor/Engineer). The client's answer describes one. This document follows the client's answer. Please confirm the second signature is genuinely being dropped, as this is a change to a controlled process. | Drives UR-043 to UR-046 | Before PRD |
| OI-05 | **Confirm AS-02.** The client stated "no fail will happen, it is just checklist". Four of the twelve templates define numeric specification limits and Pass/Fail columns. This document records the readings but does not act on them. Please confirm no action is required when a reading falls outside specification. | Drives UR-033 and whether a non-conformance workflow is needed | Before PRD |
| OI-06 | **Confirm "archive in DMS".** Which system, and is export sufficient, or is direct integration expected? | Drives UR-059 and OS-04 | Phase 2 |
| OI-07 | **Server access.** IP or hostname, SSH user, authentication method, and whether the server is production or staging. This is currently blocking Phase 0 recon. | Blocks all deployment work | **Immediately** |
| OI-08 | **Confirm the 1M frequency cascade.** Templates defining 1M items state the cascade differently — `CE 95 043 00 01` reads "For 6M and Y maintenance, 1M and 6M must be performed at the same time", which appears to be a transcription error. Please confirm the intended rule. | Drives UR-024 | Before PRD |

---

# 9. Sign-Off

By signing below, the client confirms that the requirements stated in this document are a
complete and accurate statement of what the BamForm system is required to do, and
authorises the project to proceed to Phase 2 (Product Requirement Document).

Approval of this document does not authorise implementation. Implementation begins only
after the PRD and the technical document set are approved in turn.

| Role | Name | Signature | Date |
|---|---|---|---|
| Client sign-off authority | ____________________ | ____________________ | ____________ |
| Maintenance Department representative | ____________________ | ____________________ | ____________ |
| Quality / Document Control representative | ____________________ | ____________________ | ____________ |
| Lead Engineer, BamForm | ____________________ | ____________________ | ____________ |

**Changes requested before sign-off** — please record below or return annotated:

_____________________________________________________________________________

_____________________________________________________________________________

_____________________________________________________________________________

---

*End of document — BAMFORM-URD-001 Revision 0.1*
