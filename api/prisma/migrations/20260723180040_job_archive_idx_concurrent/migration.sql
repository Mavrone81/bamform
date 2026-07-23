-- Reversal: DROP INDEX CONCURRENTLY "job_archive_idx";
--
-- Archive browsing. CONCURRENTLY per M-06.
CREATE INDEX CONCURRENTLY "job_archive_idx"
  ON "job" ("archived_at" DESC)
  WHERE "status" = 'archived';
