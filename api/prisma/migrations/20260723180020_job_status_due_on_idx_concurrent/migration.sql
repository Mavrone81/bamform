-- Reversal: DROP INDEX CONCURRENTLY "job_status_due_on_idx";
--
-- Overdue and due-soon queries (UR-026, UR-030). CONCURRENTLY per M-06.
CREATE INDEX CONCURRENTLY "job_status_due_on_idx"
  ON "job" ("status", "due_on")
  WHERE "status" NOT IN ('archived', 'voided');
