# Design — Maintainer-fillable Special Tools + Parts Used, and full 12-form field-capture fidelity

Date: 2026-07-29
Status: Approved (owner decisions locked below); ready for implementation plan
Owner sign-offs captured: Samuel (2026-07-29)

## 1. Problem

On the paper PM forms, "Special Tools Required" and "Parts Required" are blank
regions the maintainer writes into during the job. BamForm currently models both
as **standing content** (template-fixed text) — every rendered record prints the
literal `________` blank and an empty parts table — so a maintainer cannot record
the tools or parts they actually used.

Beyond those two fields, the owner directed a broader requirement: **every field a
human fills on any of the 12 controlled forms must be capturable in the web app.**
This design therefore also folds in a full field-capture audit of all 12 forms and
resolves (or explicitly defers, with reasons) every gap it found.

## 2. Current state (verified in code, 2026-07-29)

- The record/PDF already renders **three** relevant sections: `Special Tools` and
  `Parts Required` (both from template *standing content*) and a separate
  `Parts Used` section rendered from per-job `PartUsed` rows.
- **Parts Used has a working backend, including offline:** the `PartUsed` model,
  `PartsService.recordPart`, `POST /jobs/:id/parts`, and the offline sync path
  (`api/src/sync/sync-outbox.service.ts` routes `kind:'part'`;
  `api/src/sync/outbox-dispatch.ts` matches `POST /jobs/{id}/parts`, idempotent by
  mutation id). `partsUsed` is already in the canonical signed record
  (`api/src/jobs/canonical-job-record.ts`) and the PDF. **The only gap is that the
  web maintainer capture screen (`web/src/screens/RecordCapture.tsx`) never
  surfaces parts.**
- **Special Tools has no per-job capture at all** — no column, no endpoint, no UI.
- The offline outbox is generic: it stores `{method, path, body, idempotencyKey}`
  mutations and replays them via `POST /sync/outbox`; the server allow-lists
  `PUT /jobs/{id}/items/{id}`, `PUT /jobs/{id}/measurements/{id}`, and
  `POST /jobs/{id}/parts`. Edit window is enforced by the existing
  `job-status-guard` (`ASSIGNED`/`IN_PROGRESS` only).

### Maintainer capture model (ground truth)

Header is derived (document number, title incl. machine number, revision,
frequency, asset, due date, job number). Per checklist item: `status ∈ {DONE,
NOT_APPLICABLE, NOT_DONE}` + optional `remark`. Per measurement:
`readingNumeric | readingText` + optional `remark`, with a `PASS/FAIL/
NOT_EVALUATED` judgement derived server-side from the spec range. Parts used:
`{partNo?, description, quantity, remarks?}`. Attachments: photos. Signatures:
maintainer drawn signature at submit + two-stage verifier (Team Leader, Engineer)
via the approval workflow. Standing content (PPE / Safety / Procedure /
template-level remark) is printed reference, not filled.

## 3. Twelve-form audit result

With **Parts Used** and **Special Tools** added, every per-field input region is
captured on **11 of 12 forms**. Confirmed across all 12:

- Checklist `Status` is a single mark per row — **no** per-item date, initials, or
  value column on any form. The paper has *less* per-item structure than the app.
- No running-hours/counter field, no maintainer-written "next due date", no
  free-form "abnormalities" box (per-item / per-measurement `remark` covers ad-hoc
  notes).
- Single-reading measurements map to `readingNumeric` / `readingText` + derived
  judgement with no loss.
- Sign-offs (performed-by + two verifiers, name + date each) map to the maintainer
  + two-stage verifier workflow.

### Residual gaps and dispositions

1. **Multi-machine forms (structural).** `CE-95-020-00-01` (ASM Wire Bond) prints
   four machine columns (AW01–AW04): one paper PM event, one shared sign-off, four
   machines. **Decision (Samuel): one record per machine.** Each machine is its own
   asset (slice-27 model: one `asset_document` = one machine → one job), so four
   machines produce four independently auditable PM records. No field is lost. A
   future "copy checklist to sibling machines / batch complete" convenience may be
   added if maintainer effort proves burdensome; **not in scope here.**
2. **Machine-variant spec columns.** `CE-95-020-00-02` (Besi Esec Wire Bond) carries
   two spec pairs per calibration row (ESEC 3100 vs 3200); the loader doubled every
   row. The missing datum is *which variant this machine is*. **Deferred:** v1
   records the applicable reading and leaves the inapplicable twin
   `NOT_EVALUATED`. A later slice adds a per-asset variant selector (or
   variant-specific templates). One form affected.
3. **Embedded label blank.** `CE-95-010-00-01` (Die Attach) A64 —
   `"Recipe name : ____ …"` is a maintainer-written identifier separate from the
   pass/fail reading. **Deferred:** route into the existing measurement `remark`;
   promote to a first-class optional per-measurement label field only if the owner
   later wants it. One form affected.
4. **Embedded acceptance values in instructions.** Bump/E-test items
   (`"~25~30"`, `"< 2.0 ohm"`, `"< 1.0 ohm"`) are Status-only on paper, so the app
   already matches the paper with no loss. Capturing the actual gauge/ohm value is
   an **enhancement** (convert those template rows to measurements), **not** a
   required gap-fill. Deferred.
5. **Machine number in title.** Confirmed across `MB_____`, `DP_____`, `______`
   (050-01), `IMOS 0__`, `AVS 35-____`. **Already shipped as M-4** (`282834d`).

### Cross-cutting confirmations (verify during build; not new fields)

- A single sheet mixes 1M/3M/6M/Y items; a real service run performs several bands
  at once ("For Y, 3M and 6M must be performed at the same time"). The frequency
  **cascade** already scopes a Y/6M job to include the lower-frequency items;
  confirm the capture screen shows the full applicable item subset for such a job.
- Confirm the workflow surfaces all three sign-off dates (performed-by + two
  verifiers), which the paper wants distinct.
- Owner sanity-check: `CE-95-030-00-01`'s revision history references measurement
  recording that is absent from the current revision — confirm that drop was
  intentional. (Owner action, not code.)

## 4. Build design — two slices (A then B)

Each slice is its own spec-referenced plan → implementer → Opus review → merge,
per the standing flow. Both are edit-window-guarded (`ASSIGNED`/`IN_PROGRESS`) and
offline-capable via the existing outbox.

### Slice A — Parts Used capture UI (web-mostly)

Surface parts capture in `RecordCapture.tsx`: a Parts Used section where the
maintainer adds rows (`partNo` optional, `description`, `quantity`, `remarks`
optional), edits them, and removes them, all offline through the outbox.

Backend additions (the direct `POST` and its offline dispatch already exist):

- **Edit / remove.** Owner decision: editing and removing an already-recorded part
  is allowed. Honour the non-negotiables — *edit* is an `UPDATE` on the
  `part_used` record-result table (permitted during the pre-signing capture window,
  exactly as item/measurement results are upserted); *remove* is a **soft flag**
  (`part_used.active = false`), never a physical `DELETE` (non-negotiable #7).
  - Schema: add `active Boolean @default(true)` to `part_used` (migration).
  - Endpoints: `PUT /jobs/{id}/parts/{partId}` (update fields; may set `active`),
    edit-window-guarded, audit-logged in the same transaction.
  - Sync: extend `matchOutboxRoute` and `sync-outbox.service.ts` so the new
    `PUT /jobs/{id}/parts/{partId}` route replays offline, idempotent by mutation
    id.
  - Canonical record + PDF + verifier review must **exclude** `active = false`
    parts. (`canonical-job-record.ts`, `pdf-record-assembly.service.ts` /
    `pdf-html-template.ts`, `RecordReview`.) Excluding a soft-removed row changes
    what is signed — correct, and it happens before signing.
- **Web capture.** Local staging in Dexie; enqueue an outbox mutation per confirmed
  add/edit/remove. Never clear an outbox entry optimistically (non-negotiable #1) —
  a row is confirmed only after server ack. Component + offline tests; an e2e that
  adds a part offline and syncs.

### Slice B — Special Tools capture (full-stack)

A single free-text "Special Tools Used" field the maintainer fills.

- **Schema:** `job.special_tools_used TEXT NULL` (migration).
- **API:** `PUT /jobs/{id}/special-tools` with body `{ text: string | null }` —
  upsert semantics (last-write-wins, single field), edit-window-guarded,
  audit-logged in the change transaction. Shared `specialToolsInputSchema` in
  `@bamform/shared`.
- **Sync:** add a `PUT /jobs/{id}/special-tools` route to `matchOutboxRoute`
  (new `kind:'special-tools'`) and dispatch it in `sync-outbox.service.ts`, so it
  replays offline like item/measurement upserts (idempotent by mutation id).
- **Canonical / integrity:** add `specialToolsUsed` to `CanonicalJobInput` and
  `buildCurrentCanonicalRecord`. This is signed record content, so it enters the
  hash and the integrity check exactly as parts already do. Consequence: a
  **deliberate, one-time regeneration of the frozen golden hash (U-SIG-01)**,
  performed and documented explicitly — never a casual regen.
- **PDF:** the `Special Tools` section renders the captured `job.special_tools_used`
  when present; falls back to the standing template value (today `________`) when
  the maintainer left it blank.
- **Web capture:** a free-text field in `RecordCapture`, offline via the outbox
  (`PUT` upsert). Tests: canonical-hash change, API + sync dispatch, PDF renders the
  captured value, web offline capture.

## 5. Out of scope (explicit)

- Combined multi-machine records (decision: one record per machine).
- Machine-variant spec selection (gap 2, deferred).
- First-class per-measurement label field / recipe-name promotion (gap 3, deferred
  to `remark`).
- Capturing acceptance readings currently modelled as checklist items (gap 4,
  deferred; a template-data change, not this build).
- Any change to the standing "Parts Required" template table — it remains optional
  template guidance; the maintainer's actual parts live in "Parts Used".

## 6. Risks

- **Golden-hash regen (Slice B)** is the guarded operation; do it deliberately, with
  the canonical-record test updated in the same commit, and note it in the plan.
- **Soft-removed parts in the signed record (Slice A):** ensure every read path that
  feeds the signature/PDF/integrity excludes `active = false`, or a removed part
  could still be hashed/printed. Covered by tests on canonical + PDF.
- **Offline idempotency:** add/edit/remove replays must not double-apply; each rides
  the existing per-mutation idempotency-store keyed by outbox mutation id.
