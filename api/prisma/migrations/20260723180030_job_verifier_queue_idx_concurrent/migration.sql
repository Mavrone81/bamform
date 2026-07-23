-- Reversal: DROP INDEX CONCURRENTLY "job_verifier_queue_idx";
--
-- Verifier queue (UR-049). CONCURRENTLY per M-06.
CREATE INDEX CONCURRENTLY "job_verifier_queue_idx"
  ON "job" ("current_stage_ordinal", "submitted_at")
  WHERE "status" = 'submitted';
