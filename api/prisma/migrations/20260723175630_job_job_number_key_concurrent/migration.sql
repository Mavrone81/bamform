-- Reversal: DROP INDEX CONCURRENTLY "job_job_number_key";
--
-- Lookup by reference (DBD §8). CONCURRENTLY per M-06 (job is a large
-- table); split into its own migration so Prisma runs this single statement
-- outside a transaction (CONCURRENTLY cannot run inside one).
CREATE UNIQUE INDEX CONCURRENTLY "job_job_number_key" ON "job"("job_number");
