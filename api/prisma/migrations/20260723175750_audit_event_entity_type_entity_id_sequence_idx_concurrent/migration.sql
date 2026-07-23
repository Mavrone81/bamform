-- Reversal: DROP INDEX CONCURRENTLY "audit_event_entity_type_entity_id_sequence_idx";
--
-- Per-record audit view (UR-078). CONCURRENTLY per M-06.
CREATE INDEX CONCURRENTLY "audit_event_entity_type_entity_id_sequence_idx"
  ON "audit_event"("entity_type", "entity_id", "sequence");
