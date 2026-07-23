-- Reversal: DROP INDEX CONCURRENTLY "item_result_job_id_template_item_id_key";
--
-- INV-08 — one result per item per job. CONCURRENTLY per M-06 (item_result
-- is a large table).
CREATE UNIQUE INDEX CONCURRENTLY "item_result_job_id_template_item_id_key"
  ON "item_result"("job_id", "template_item_id");
