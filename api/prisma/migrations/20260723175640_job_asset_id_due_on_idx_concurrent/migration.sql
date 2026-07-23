-- Reversal: DROP INDEX CONCURRENTLY "job_asset_id_due_on_idx";
--
-- Asset maintenance history (UR-007). CONCURRENTLY per M-06.
CREATE INDEX CONCURRENTLY "job_asset_id_due_on_idx" ON "job"("asset_id", "due_on" DESC);
