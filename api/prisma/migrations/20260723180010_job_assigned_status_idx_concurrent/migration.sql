-- Reversal: DROP INDEX CONCURRENTLY "job_assigned_to_status_idx";
--
-- Technician's job list — the hottest query (DBD §8). CONCURRENTLY per M-06
-- (job is a large table); this file holds exactly one statement so Prisma
-- does not wrap it in a transaction (CONCURRENTLY cannot run inside one).
CREATE INDEX CONCURRENTLY "job_assigned_to_status_idx"
  ON "job" ("assigned_to", "status")
  WHERE "status" IN ('assigned', 'in_progress');
