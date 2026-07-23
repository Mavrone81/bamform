-- Reversal: DROP INDEX CONCURRENTLY "measurement_result_job_id_template_measurement_id_key";
--
-- One result per measurement per job. CONCURRENTLY per M-06.
CREATE UNIQUE INDEX CONCURRENTLY "measurement_result_job_id_template_measurement_id_key"
  ON "measurement_result"("job_id", "template_measurement_id");
