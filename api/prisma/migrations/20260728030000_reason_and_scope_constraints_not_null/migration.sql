-- Reversal:
--   ALTER TABLE "job" DROP CONSTRAINT "job_adhoc_frequency_scope_chk";
--   ALTER TABLE "job" DROP CONSTRAINT "job_adhoc_reason_length_chk";
--   ALTER TABLE "job" ADD CONSTRAINT "job_adhoc_reason_length_chk"
--     CHECK ("is_adhoc" = false OR length("adhoc_reason") >= 10);
--   ALTER TABLE "job" DROP CONSTRAINT "job_void_reason_length_chk";
--   ALTER TABLE "job" ADD CONSTRAINT "job_void_reason_length_chk"
--     CHECK ("status" <> 'voided' OR length("void_reason") >= 10);
--   ALTER TABLE "approval_step" DROP CONSTRAINT "approval_step_return_reason_length_chk";
--   ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_return_reason_length_chk"
--     CHECK ("action" <> 'returned' OR length("reason") >= 10);
--   (i.e. reversal restores the three constraints WITH the NULL hole this
--   migration closes — it is a weakening, and only worth doing to roll back
--   to the exact prior schema.)
--
-- Slice 18-WORKFLOW fix pass — review findings X-6 and disclosed concern 5.
--
-- ============================================================ 1. THE NULL HOLE
--
-- `CHECK (cond OR length(col) >= 10)` does NOT make `col` mandatory. With
-- `col IS NULL`, `length(NULL) >= 10` evaluates to NULL, `false OR NULL` is
-- NULL, and Postgres ACCEPTS a CHECK whose result is not FALSE. Measured by
-- the reviewer with direct INSERTs as the DB owner:
--
--   is_adhoc = true,  adhoc_reason = NULL     -> ACCEPTED  (should be rejected)
--   is_adhoc = true,  adhoc_reason = 'short'  -> correctly rejected
--   status   = 'voided', void_reason = NULL   -> ACCEPTED  (INV-12, same hole)
--
-- So slice 18's claim that the ad-hoc reason is "enforced by the DATABASE,
-- not the service alone" was overstated, and INV-12 (void reason, UR-054) and
-- INV-13 (return reason, UR-047) have carried the identical defect since
-- slice 1. The NULL case is exactly the shape a future code path that forgets
-- to set the reason would take — the case the constraint exists to catch.
--
-- All three are corrected here with an explicit `IS NOT NULL` conjunct.
--
-- EXISTING-ROW SAFETY. `job.is_adhoc` was never written before slice 18, so
-- the ad-hoc constraint provably cannot fail on existing data. The INV-12/13
-- tightenings touch real historical rows: every void and every return in this
-- system is created through `ApprovalTransitionsService`, whose Zod DTOs
-- (`voidJobRequestSchema` / `returnJobRequestSchema`) require >= 10 trimmed
-- characters, so no NULL-reason row should exist. The DO blocks below verify
-- that BEFORE altering anything and raise a specific, actionable error naming
-- the offending ids if one does — a deploy that halts here has found a
-- voided/returned record with no recorded reason, which is a real compliance
-- problem to investigate, not a migration to force through.

DO $$
DECLARE
  v_ids text;
BEGIN
  SELECT string_agg("id"::text, ', ') INTO v_ids
  FROM "job"
  WHERE "status" = 'voided' AND "void_reason" IS NULL;

  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'INV-12 tightening blocked: voided job(s) with a NULL void_reason exist: %. UR-054 requires a recorded reason for every void; investigate these records before re-running this migration.',
      v_ids;
  END IF;
END $$;

DO $$
DECLARE
  v_ids text;
BEGIN
  SELECT string_agg("id"::text, ', ') INTO v_ids
  FROM "approval_step"
  WHERE "action" = 'returned' AND "reason" IS NULL;

  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'INV-13 tightening blocked: returned approval_step(s) with a NULL reason exist: %. UR-047 requires a recorded reason for every return; investigate these records before re-running this migration.',
      v_ids;
  END IF;
END $$;

ALTER TABLE "job" DROP CONSTRAINT "job_adhoc_reason_length_chk";
ALTER TABLE "job"
  ADD CONSTRAINT "job_adhoc_reason_length_chk"
  CHECK ("is_adhoc" = false OR ("adhoc_reason" IS NOT NULL AND length("adhoc_reason") >= 10));

ALTER TABLE "job" DROP CONSTRAINT "job_void_reason_length_chk";
ALTER TABLE "job"
  ADD CONSTRAINT "job_void_reason_length_chk"
  CHECK ("status" <> 'voided' OR ("void_reason" IS NOT NULL AND length("void_reason") >= 10));

ALTER TABLE "approval_step" DROP CONSTRAINT "approval_step_return_reason_length_chk";
ALTER TABLE "approval_step"
  ADD CONSTRAINT "approval_step_return_reason_length_chk"
  CHECK ("action" <> 'returned' OR ("reason" IS NOT NULL AND length("reason") >= 10));

-- ================================================ 2. THE EMPTY-SCOPE INVARIANT
--
-- Slice 18's own report flagged this as its recommended first follow-up, and
-- the review agreed: `frequency_scope = '{}'` is now SEMANTICALLY LOAD-BEARING
-- and was enforced by nothing.
--
-- An ad-hoc job satisfies no schedule period, and that is implemented purely
-- by giving it an empty scope: `CompletionCascadeService#apply` and
-- `VoidScheduleRecomputeService#apply` are both DRIVEN BY that array, so an
-- empty one is a structural no-op at every call site. An INSERT that gave an
-- ad-hoc job a non-empty scope — a future code path, a data fix, a bulk load —
-- would silently make it credit and advance the maintenance plan, which is the
-- one thing the whole deliverable promises it cannot do.
--
-- `frequency_scope` is a nullable column, so the NULL arm is spelled out for
-- exactly the reason section 1 above exists.
--
-- Existing-row safety: every ad-hoc row can only have been created by
-- `AdhocJobService`, which always writes `[]`.
ALTER TABLE "job"
  ADD CONSTRAINT "job_adhoc_frequency_scope_chk"
  CHECK (
    "is_adhoc" = false
    OR ("frequency_scope" IS NOT NULL AND cardinality("frequency_scope") = 0)
  );
