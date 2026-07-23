-- Reversal: DROP INDEX CONCURRENTLY "measurement_result_template_measurement_id_recorded_at_idx";
--
-- Measurement trending (UR-070). CONCURRENTLY per M-06 (measurement_result
-- is a large table).
CREATE INDEX CONCURRENTLY "measurement_result_template_measurement_id_recorded_at_idx"
  ON "measurement_result"("template_measurement_id", "recorded_at");
