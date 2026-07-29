-- Slice 27-ASSETDOC, review m-2 — defence in depth, not a live bug fix.
--
-- Reversal: ALTER TABLE "job" DROP CONSTRAINT "job_asset_document_id_asset_id_fkey";
--           ALTER TABLE "asset_document" DROP CONSTRAINT "asset_document_id_asset_id_key";
-- Both are pure constraints — dropping them loses no data and re-adding them
-- only succeeds while every job's document belongs to that job's machine.
--
-- `job` denormalises: it carries BOTH `asset_id` (a record is about a machine —
-- every read path, report and area-scope filter keys off it) and, since slice
-- 27, `asset_document_id` (WHICH document it satisfies). Nothing until now made
-- the two agree.
--
-- Every current write path was reviewed and is safe: `job-generation` takes both
-- from the same `rule.assetDocument`, and `adhoc-job` resolves the document from
-- the machine's own active documents. So no such row exists or can be created
-- today.
--
-- But if one ever did exist, a completion on machine X would advance machine Y's
-- schedule through the CORRECTLY document-scoped cascade — spec §4.3's
-- cross-document defect arriving through a denormalisation mismatch rather than
-- through a scoping bug, and invisible to every test that pins the scoping. A
-- composite foreign key forecloses the whole class for the cost of one index.
--
-- The FK needs a unique constraint on exactly its referenced column set;
-- `id` alone being the primary key is not enough.
ALTER TABLE "asset_document"
  ADD CONSTRAINT "asset_document_id_asset_id_key" UNIQUE ("id", "asset_id");

ALTER TABLE "job"
  ADD CONSTRAINT "job_asset_document_id_asset_id_fkey"
  FOREIGN KEY ("asset_document_id", "asset_id")
  REFERENCES "asset_document" ("id", "asset_id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Existing-row safety: this is additive and validates every existing row on
-- creation. Against production's 6 jobs — all raised before a machine could
-- carry more than one document, so all pointing at their own machine's single
-- backfilled document — it cannot fail. If it ever DOES fail on some other
-- database, that is the constraint doing its job: a job pointing at another
-- machine's document is exactly the corruption this exists to detect, and it
-- must be investigated rather than worked around.
