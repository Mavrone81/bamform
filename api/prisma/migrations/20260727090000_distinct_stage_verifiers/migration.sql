-- Slice 15-SYSWIRE (system-review-2026-07-27 SYS-8) — two-verifier means two
-- PEOPLE. The service layer rejects a stage-2 verify by the stage-1 actor
-- (`verification.service.ts`); this trigger is the database backstop for a
-- genuine race or a direct-DB write, mirroring INV-05's
-- `enforce_verifier_not_submitter` service-AND-trigger pattern (slice 1,
-- 20260723180000_invariants).
--
-- Cycle semantics: a `returned`/`recalled` step supersedes every earlier
-- verification signature (the content they signed is about to change), so
-- only `verified` steps AFTER the most recent cycle break count — the same
-- person may legitimately verify the reworked record in a later cycle.
--
-- Reversal:
--   DROP TRIGGER "approval_step_distinct_stage_verifiers_trg" ON "approval_step";
--   DROP FUNCTION enforce_distinct_stage_verifiers();

CREATE FUNCTION enforce_distinct_stage_verifiers() RETURNS trigger AS $$
DECLARE
  v_cycle_start timestamptz;
BEGIN
  IF NEW."action" = 'verified' THEN
    SELECT max("acted_at") INTO v_cycle_start
    FROM "approval_step"
    WHERE "job_id" = NEW."job_id"
      AND "action" IN ('returned', 'recalled');

    IF EXISTS (
      SELECT 1 FROM "approval_step" s
      WHERE s."job_id" = NEW."job_id"
        AND s."action" = 'verified'
        AND s."actor_id" = NEW."actor_id"
        AND (v_cycle_start IS NULL OR s."acted_at" > v_cycle_start)
    ) THEN
      RAISE EXCEPTION
        'approval_step: actor % already verified a stage of job % in this submission cycle — the two verification signatures must come from two different people (SYS-8)',
        NEW."actor_id", NEW."job_id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "approval_step_distinct_stage_verifiers_trg"
  BEFORE INSERT ON "approval_step"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_distinct_stage_verifiers();
