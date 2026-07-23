-- Reversal: DROP INDEX CONCURRENTLY "audit_event_occurred_at_brin_idx";
--
-- Time-range scans over a large append-only table (DBD §8 BRIN note).
-- CONCURRENTLY per M-06 (audit_event is a large table). BRIN has no
-- meaningful ASC/DESC ordering (it stores per-block min/max summaries), so
-- unlike the DBD table's "(occurred_at DESC)" notation this omits a sort
-- direction — functionally equivalent for the range-scan use case it serves.
CREATE INDEX CONCURRENTLY "audit_event_occurred_at_brin_idx"
  ON "audit_event" USING BRIN ("occurred_at");
