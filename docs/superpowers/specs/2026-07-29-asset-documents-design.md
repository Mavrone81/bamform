# Slice 27-ASSETDOC — a machine carries many documents

**Date:** 2026-07-29
**Status:** awaiting owner review
**Owner decisions folded in:** a machine is tagged with several PM documents by an admin; the admin fills **only** the form-number blank (`KW__`, `ED__`); every other field on the form is filled by the maintainer.

---

## 1. The problem

The owner's process step 2 is *"Admin will log in to setup the machine tagged with which preventive Maintenance document — all the forms in the doc folder"*, and step 4 is *"he will go to his assigned machine and select the form to start"*. Neither is possible today.

A machine can hold exactly one document:

```prisma
Asset.assetTypeId  →  AssetType.formTemplateId  @unique
```

`@unique` makes it one-to-one in both directions — a machine has one form, and a form belongs to one machine type.

A second, independent rule blocks the schedule even if the first were relaxed:

```prisma
ScheduleRule  @@unique([assetId, frequency])   // one schedule per MACHINE per frequency
```

Both are contradicted by the owner's own 2026 schedule workbook. Measured from that file: **12 machines carry more than one document**, and there are **9 machine+frequency combinations that need two or more documents at the same interval** — TE7 needs a monthly pH-meter check *and* its monthly preventive maintenance; LM03 needs three monthly documents; TH01 needs two at 3M and two more at 6M.

So today: step 2 cannot be performed, step 4 has nothing to select, and nine scheduled items cannot be represented at all.

## 2. Why now

Production holds 3 scheduled, 2 voided and 1 in-progress job, and **zero archived records**. This change therefore needs no data migration against signed records. After go-live it would.

## 3. Scope

**In:** the `asset_document` model, the `schedule_rule` re-key, the five scheduling services, job generation's template selection, the form-number substitution, and the read/write API for tagging.

**Out:** the admin tagging screen and the maintainer's form-selection screen — slice 28-ASSETDOC-UI. This slice ships the model and the API those screens consume, and is verifiable without them.

Not in scope and explicitly unchanged: the approval chain, signatures, the audit chain, and the record capture UI.

## 4. Design

### 4.1 The tag

```prisma
model AssetDocument {
  id             String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  assetId        String   @map("asset_id") @db.Uuid
  formTemplateId String   @map("form_template_id") @db.Uuid
  /// Fills the blank in the template title: "…Record KW___" + "13" -> "…Record KW13".
  /// NULL for templates whose title carries no blank (CE 95 012 00 01 is fixed "EP01").
  machineNumber  String?  @map("machine_number")
  active         Boolean  @default(true)

  asset         Asset         @relation(fields: [assetId], references: [id])
  formTemplate  FormTemplate  @relation(fields: [formTemplateId], references: [id])
  scheduleRules ScheduleRule[]

  @@unique([assetId, formTemplateId])
  @@map("asset_document")
}
```

`@@unique([assetId, formTemplateId])` — the same document cannot be tagged twice to one machine. Different machines may share a document freely, which is what `AssetType.formTemplateId @unique` wrongly prevented (CM02 and CM03 both use CE 95 030 00 01; T8, T69 and ST01 all use CE 95 050 00 01).

`AssetType` **keeps** `approvalRouteId` and `leadTimeDays` and **loses** `formTemplateId`. It remains the machine-family grouping; it stops being the route to a form.

### 4.2 Re-keying the schedule

```prisma
ScheduleRule {
  assetDocumentId  String  @map("asset_document_id") @db.Uuid   // was assetId
  frequency, intervalMonths, anchorDate, lastCompletedOn, nextDueOn   // unchanged
  @@unique([assetDocumentId, frequency])                        // was [assetId, frequency]
}
```

Frequencies already derive from the template's own active items (`schedule-rule-bootstrap.service.ts:72-75`, `distinct: ['frequency']`), so each document naturally brings its own set. A machine's pH document contributing a 1M rule no longer collides with its PM document contributing another.

### 4.3 `Job` gains the document

`Job` already carries `assetId`, `templateRevisionId`, `frequency` and `frequencyScope` — it is already a (machine, document revision, frequency) triple, which is why the *record* side needs no rework. It gains `assetDocumentId` so the two services that walk backwards from a completed job can find the right rules:

- `completion-cascade.service.ts` — advances the rules a completion satisfies.
- `void-schedule-recompute.service.ts` — reverses that when an archived job is voided.

Both currently resolve rules by `assetId` + the job's frozen `frequencyScope`. Scoped to the asset alone they would now advance **another document's** schedule — a machine's PM completion would silently mark its pH check as done. This is the single most dangerous defect available in this slice and the tests in §6 target it directly.

### 4.4 Template selection

`job-generation.service.ts:104-105` selects the current revision via `asset.assetType.formTemplateId`. It becomes `rule.assetDocument.formTemplateId`. `approvalRouteId` continues to come from `asset.assetType` — the approval chain is a property of the machine family, not of the document.

### 4.5 The form-number blank

The admin supplies only `machineNumber`. Substitution happens at render, from the template's title, by a rule with one shape:

> A run of **two or more** underscores in the title is replaced by `machineNumber`.

Measured against the 12 real templates: 8 carry such a run (`ED____`, `KW___`, `EW_____`, `MB_____`, `DP_____`, `AVS 35-____`, `IMOS 0__`, and CE 95 050 00 01's bare `______`); `EP01` and `PM01` are fixed strings; CE 95 020 00 01 and CE 95 043 00 01 have no blank.

Consequences, stated rather than left implicit: if the title has no run, `machineNumber` must be null and supplying one is a validation error — silently ignoring it would let an admin believe they had labelled a form when they had not. If the title has a run and `machineNumber` is null, the title renders with the blank intact, exactly as the paper form does before someone writes on it.

Substituted at render, not stored, so a template revision that changes the title stays correct. Slice 23-PDFA freezes the rendered result at archive, so an archived record still keeps the title it was signed under.

### 4.6 API

- `GET /assets/{assetId}/documents` — the machine's tagged documents. This is what step 4's form picker reads.
- `POST /assets/{assetId}/documents` — tag one. ADMIN only.
- `PATCH /asset-documents/{id}` — change `machineNumber`, or deactivate.

Deactivation, never deletion: `INV-16` forbids DELETE on record tables, and a document that has generated jobs must remain resolvable. Deactivating stops future job generation and leaves history intact.

## 5. Migration

1. Create `asset_document`.
2. For every existing asset, insert one row from its `assetType.formTemplateId`, `machineNumber` null, active true — preserving today's behaviour exactly.
3. Add `schedule_rule.asset_document_id`, backfill by joining on `asset_id`, then drop `asset_id` and swap the unique index.
4. Add `job.asset_document_id`, backfill the same way.
5. Drop `asset_type.form_template_id`.

Steps 3 and 4 are backfill-then-drop rather than a bare column swap, so the migration is safe against the 6 existing jobs and their rules. Grants need no change — `grants.sql` re-runs `GRANT … ON ALL TABLES` after every migration.

## 6. Testing

The tests that matter are the cross-document ones. Everything else is ordinary CRUD coverage.

- **A completion advances only its own document's schedule.** Tag two documents to one machine at the same frequency, complete one, assert the other's `nextDueOn` and `lastCompletedOn` are untouched. Without §4.3 this fails, and it is the defect most likely to reach production unnoticed.
- **A void reverses only its own document's schedule.** Same shape, through archive → void.
- **Two documents at the same frequency on one machine both generate jobs** — the case the old unique key made impossible, and the one the owner's TE7 needs.
- **Job generation picks the template from the document, not the asset type** — assert two jobs raised for one machine carry different `templateRevisionId`s.
- Form-number substitution: each of the three title shapes (run present, no run, run with null number), plus the validation error.
- Migration: applied to a database seeded in the *old* shape, every existing asset ends with exactly one document, every rule and job re-pointed, no orphans.

## 7. Risks

- **Cross-document schedule leakage** (§4.3) — the reason `completion-cascade` and `void-schedule-recompute` get dedicated tests rather than being assumed correct after a mechanical re-point.
- **`AssetType.formTemplateId` is referenced by the template loader** (`scripts/template-load/src/loader.ts`), which creates an asset type per document. It must instead create the template and let tagging happen separately; the 12 loaded templates must survive the change.
- The re-key touches five services. Their existing tests are the safety net and must all continue to pass unmodified except where the fixture shape genuinely changed.

## 8. Open

None blocking. The verification documents (9 check types) are still outstanding from the owner, but they are needed for slice 19-SCHEDULE's import, not for this model — the model holds them the moment they exist.
