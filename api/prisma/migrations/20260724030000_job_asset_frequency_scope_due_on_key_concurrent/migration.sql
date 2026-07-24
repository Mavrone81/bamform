-- Reversal: DROP INDEX CONCURRENTLY "job_asset_frequency_scope_due_on_key";
--
-- PR-052 (I-INV-14) — job generation is idempotent, keyed on
-- (asset_id, frequency_scope, due_on): a repeated scheduler run cannot
-- create a duplicate job for the same asset/scope/due-date. Enforced here
-- at the database, not merely by an application-level check-then-insert
-- (DP-5: an application defect must not be able to corrupt the archive with
-- a duplicate PM record). frequency_scope is frequency_t[] — Postgres
-- arrays have a default btree operator class, so a unique index over an
-- array column works exactly like any other; the caller
-- (job-generation.service.ts) is responsible for storing the array in a
-- canonical (interval-ascending) order, since array equality here is
-- POSITIONAL, not set equality.
--
-- CONCURRENTLY per M-06 (job is a large table); split into its own
-- migration so Prisma runs this single statement outside a transaction.
CREATE UNIQUE INDEX CONCURRENTLY "job_asset_frequency_scope_due_on_key"
  ON "job"("asset_id", "frequency_scope", "due_on");
