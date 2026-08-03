-- Slice 31-TITLEBLANK — the technician fills the blank in the form's TITLE.
-- Additive, nullable, no backfill. Forward-only; edits no prior migration.
--
-- Reversal:
--   ALTER TABLE "job" DROP CONSTRAINT "job_title_machine_number_chk";
--   ALTER TABLE "job" DROP COLUMN "title_machine_number";
--
-- Reversing is safe for the schema and for every record signed BEFORE this
-- migration: the column is never part of the canonical signed content
-- (`canonical-job-record.ts`), so dropping it cannot change any stored
-- `content_hash` and `GET /records/{id}/integrity` is unaffected either way.
-- What it LOSES is the value itself: every record captured after this
-- migration falls back to `asset_document.machine_number` for its title, so a
-- record signed as "…Record ED01" would re-print as "…Record ED____" (or with
-- the admin's number, where one was set). Reverse only if no job has a
-- non-NULL `title_machine_number` (check: SELECT count(*) FROM "job" WHERE
-- "title_machine_number" IS NOT NULL), or accept that those titles print
-- blank again.
--
-- ---------------------------------------------------------------- why here
--
-- A record IS a job (`pdf-record-assembly.service.ts` builds a `PdfRecordInput`
-- from one, `recordId: job.id`). Until now the only value that could fill the
-- blank lived on `asset_document.machine_number`, set ONCE by an admin when
-- tagging a document to a machine. The owner has ruled that wrong: on paper
-- the technician writes it, per record. Eight of the twelve real templates
-- carry the blank (ED____, KW___, EW_____, MB_____, DP_____, AVS 35-____,
-- IMOS 0__, and CE 95 050 00 01's bare ______).
--
-- `asset_document.machine_number` is deliberately NOT dropped or backfilled
-- from: any value an admin already set must keep printing exactly as it does
-- today, and guessing which part of `AVS35-01` belongs in `AVS 35-____` is the
-- unverifiable inference slice 27's migration already had removed for being
-- wrong on two of the eight shapes. The column therefore starts NULL on every
-- existing job, and every existing record renders byte-identically to before.
--
-- ------------------------------------------------------------ immutability
--
-- No trigger work is needed for INV-09. `prevent_archived_job_update()`
-- (20260728000000) compares `to_jsonb(OLD) - ARRAY[<annotation columns>]`
-- against the same projection of NEW, so a column added later is protected by
-- default: an ARCHIVED or VOIDED job's `title_machine_number` cannot be
-- changed at the database layer, and an archived record keeps the title it was
-- signed under.
--
-- ------------------------------------------------------------- constraint
--
-- The service layer validates with the SAME Zod bounds as the admin-set
-- sibling (`shared/src/job.ts#titleMachineNumberSchema`: trimmed, 1..50). The
-- CHECK below is the database backstop for that, in the shape
-- 20260728030000 established after finding the NULL hole in the reason
-- constraints: the NULL arm is spelled out explicitly rather than relying on
-- `length(NULL)`, because a CHECK evaluating to NULL is ACCEPTED by Postgres.
-- NULL is a legitimate state here (the blank is not yet filled), so it is
-- permitted deliberately, not by accident.
ALTER TABLE "job" ADD COLUMN "title_machine_number" text;

ALTER TABLE "job"
  ADD CONSTRAINT "job_title_machine_number_chk"
  CHECK (
    "title_machine_number" IS NULL
    OR (btrim("title_machine_number") <> '' AND length("title_machine_number") <= 50)
  );

COMMENT ON COLUMN "job"."title_machine_number" IS
  'Slice 31-TITLEBLANK. The technician''s per-record entry for the blank in the template title ("…Record ED____" + "01" -> "…Record ED01"). NULL until filled; required at SUBMIT only where the title carries a fillable run. Substituted at RENDER, never stored resolved. Takes precedence over asset_document.machine_number, which remains the fallback for records captured before this column existed.';
