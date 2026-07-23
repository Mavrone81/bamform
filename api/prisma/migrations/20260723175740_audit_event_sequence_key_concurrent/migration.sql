-- Reversal: DROP INDEX CONCURRENTLY "audit_event_sequence_key";
--
-- INV-10 chain traversal (unique sequence). CONCURRENTLY per M-06
-- (audit_event is a large table).
CREATE UNIQUE INDEX CONCURRENTLY "audit_event_sequence_key" ON "audit_event"("sequence");
