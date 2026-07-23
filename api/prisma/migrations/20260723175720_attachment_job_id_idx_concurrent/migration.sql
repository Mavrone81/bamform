-- Reversal: DROP INDEX CONCURRENTLY "attachment_job_id_idx";
--
-- DBD §8 lists this index as a plain B-tree on a non-"large" table, but
-- scripts/ci/assert-concurrent-indexes.sh matches on substring "job" (from
-- the job_id column), so this is split into its own CONCURRENTLY migration
-- purely to satisfy that check — see the note in the init migration.
CREATE INDEX CONCURRENTLY "attachment_job_id_idx" ON "attachment"("job_id");
