-- Slice 27-ASSETDOC. A machine carries MANY documents.
--
-- Before: asset -> asset_type -> form_template_id (UNIQUE). One machine, one
-- form; and because the FK was UNIQUE, one form could not even be shared by
-- two machine types. The owner's 2026 schedule workbook needs 12 machines to
-- carry several documents each, and 9 machine+frequency combinations to carry
-- two or more at the SAME interval (TE7: a monthly pH-meter check AND a
-- monthly preventive maintenance; LM03 three monthly documents; TH01 two at
-- 3M and two more at 6M).
--
-- ORDER IS LOAD-BEARING. `asset_document` is populated FROM
-- `asset_type.form_template_id` before that column is dropped, and
-- `schedule_rule`/`job` are backfilled before their old columns go. Production
-- holds 1 machine, 3 schedule rules and 6 jobs; a bare column swap would lose
-- every one of them.

-- ---------------------------------------------------------------- the tag

CREATE TABLE "asset_document" (
  "id"               uuid PRIMARY KEY DEFAULT uuidv7(),
  "asset_id"         uuid NOT NULL,
  "form_template_id" uuid NOT NULL,
  "machine_number"   text,
  "active"           boolean NOT NULL DEFAULT true,
  "created_at"       timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_document_asset_id_form_template_id_key" UNIQUE ("asset_id", "form_template_id")
);

ALTER TABLE "asset_document"
  ADD CONSTRAINT "asset_document_asset_id_fkey" FOREIGN KEY ("asset_id")
    REFERENCES "asset"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "asset_document"
  ADD CONSTRAINT "asset_document_form_template_id_fkey" FOREIGN KEY ("form_template_id")
    REFERENCES "form_template"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- The form picker (step 4 of the owner's process) reads a machine's ACTIVE
-- documents; the scheduler bootstrap sweeps active documents plant-wide.
CREATE INDEX "asset_document_asset_id_active_idx" ON "asset_document" ("asset_id") WHERE "active";

COMMENT ON COLUMN "asset_document"."machine_number" IS
  'Fills the blank in the template title ("…Record KW___" + "13" -> "…Record KW13"). NULL is always valid and never a validation error: several documents carry the number in the printed title already (CE 95 012 00 01 is fixed "EP01"), and 2 of the 12 titles have no machine designation at all. Substituted at RENDER, never stored resolved.';

-- Preserve today's configuration exactly: one document per existing asset,
-- taken from the asset type it already resolves through. `machine_number` is
-- left NULL, so every migrated title renders exactly as it does today.
INSERT INTO "asset_document" ("asset_id", "form_template_id")
SELECT a."id", t."form_template_id"
  FROM "asset" a
  JOIN "asset_type" t ON t."id" = a."asset_type_id"
ON CONFLICT ("asset_id", "form_template_id") DO NOTHING;

-- ------------------------------------------------------- schedule_rule re-key

ALTER TABLE "schedule_rule" ADD COLUMN "asset_document_id" uuid;

UPDATE "schedule_rule" r
   SET "asset_document_id" = d."id"
  FROM "asset_document" d
 WHERE d."asset_id" = r."asset_id";

-- Fails loudly rather than silently orphaning if the backfill missed a row.
ALTER TABLE "schedule_rule" ALTER COLUMN "asset_document_id" SET NOT NULL;

ALTER TABLE "schedule_rule"
  ADD CONSTRAINT "schedule_rule_asset_document_id_fkey" FOREIGN KEY ("asset_document_id")
    REFERENCES "asset_document"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- `(asset_id, frequency)` was the SECOND, independent blocker on the owner's
-- process: even with many documents per machine, one schedule per machine per
-- frequency made TE7's pH check and its PM mutually exclusive.
DROP INDEX IF EXISTS "schedule_rule_asset_id_frequency_key";
ALTER TABLE "schedule_rule" DROP CONSTRAINT IF EXISTS "schedule_rule_asset_id_fkey";
ALTER TABLE "schedule_rule" DROP COLUMN "asset_id";

CREATE UNIQUE INDEX "schedule_rule_asset_document_id_frequency_key"
  ON "schedule_rule" ("asset_document_id", "frequency");

-- ---------------------------------------------------------------- job re-key
--
-- `asset_id` STAYS: a record is still about a machine, and every read path,
-- report and area-scope filter keys off it. What is new is that a job also
-- names WHICH document it satisfies — without it `completion-cascade` and
-- `void-schedule-recompute` resolve rules by machine alone and a machine's PM
-- completion silently advances its pH check's schedule (spec §4.3).

ALTER TABLE "job" ADD COLUMN "asset_document_id" uuid;

-- INV-09 (`job_archived_immutable_trg`) refuses ANY update to a job whose
-- stored status is 'archived' or 'voided' — including this one, and including
-- from the migration role, because it is a row-content check and not a
-- privilege check. Production holds 2 VOIDED jobs, so without this the
-- backfill below aborts the whole migration with
--   "job <id> is voided and immutable (INV-09 / slice 17)"
-- and slice 27 cannot be deployed at all. (Found by applying this migration to
-- a database seeded in the production shape; it is invisible against an empty
-- one, and invisible against the test suite, which truncates between tests.)
--
-- Disabling the trigger for exactly this statement is safe and does NOT weaken
-- the invariant:
--   * The migration runs inside one transaction, so the trigger is re-enabled
--     before anything else can write, and a failure rolls the disable back too.
--   * The write is a STRUCTURAL backfill, not a content change. It records the
--     document each job already implicitly pointed at through
--     asset -> asset_type -> form_template. No column INV-09 exists to protect
--     — no result, signature, approval step, reason or status — is touched.
--   * Nothing else in this migration updates `job`.
-- This is the same category of act as adding the column itself; INV-09 governs
-- application writes to record content, not schema evolution.
ALTER TABLE "job" DISABLE TRIGGER "job_archived_immutable_trg";

UPDATE "job" j
   SET "asset_document_id" = d."id"
  FROM "asset_document" d
 WHERE d."asset_id" = j."asset_id";

ALTER TABLE "job" ENABLE TRIGGER "job_archived_immutable_trg";

-- Fails loudly rather than silently orphaning if the backfill missed a row.
ALTER TABLE "job" ALTER COLUMN "asset_document_id" SET NOT NULL;

ALTER TABLE "job"
  ADD CONSTRAINT "job_asset_document_id_fkey" FOREIGN KEY ("asset_document_id")
    REFERENCES "asset_document"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ------------------------------------------------------- asset_type demotion
--
-- It remains the machine-family grouping and keeps `approval_route_id` and
-- `lead_time_days` — the approval chain is a property of the machine family,
-- not of the document. It stops being the route to a form. Dropping the column
-- drops `asset_type_form_template_id_key` (the @unique) with it, which is what
-- lets CM02 and CM03 both use CE 95 030 00 01.
ALTER TABLE "asset_type" DROP CONSTRAINT IF EXISTS "asset_type_form_template_id_fkey";
ALTER TABLE "asset_type" DROP COLUMN "form_template_id";
