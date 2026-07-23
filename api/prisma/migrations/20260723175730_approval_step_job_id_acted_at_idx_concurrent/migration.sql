-- Reversal: DROP INDEX CONCURRENTLY "approval_step_job_id_acted_at_idx";
--
-- Record signature block assembly. Same substring-match accommodation as
-- attachment_job_id_idx (see that migration's note).
CREATE INDEX CONCURRENTLY "approval_step_job_id_acted_at_idx" ON "approval_step"("job_id", "acted_at");
