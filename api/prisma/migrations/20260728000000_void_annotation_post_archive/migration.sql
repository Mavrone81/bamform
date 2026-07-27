-- Reversal: ALTER TABLE "job" DROP COLUMN "voided_at";
--           then re-CREATE OR REPLACE prevent_archived_job_update() with the
--           original 20260723180000_invariants body (OLD.status = 'archived'
--           -> unconditional RAISE; no 'voided' branch). Reversal is only
--           valid while no ARCHIVED -> VOIDED annotation exists (check:
--           SELECT count(*) FROM "job" WHERE status = 'voided' AND
--           archived_at IS NOT NULL) — reverting the trigger with such rows
--           present is safe (they simply become immutable via the archived
--           branch's absence... they are 'voided', so the ORIGINAL trigger
--           would NOT protect them at all; re-run the void-semantics
--           migration or accept service-layer-only protection for them).
--           Or restore from the pre-migration pg_dump (PR-DBD-07/08).
--
-- Slice 17-VOID — the owner's 2026-07-27 decision: "If wrong machine, void
-- the form. Void is also possible after the full process is completed."
--
-- 1. `job.voided_at` (additive, nullable): when the void was annotated.
--    Existing voided rows (all pre-archive voids) keep NULL — historically
--    the moment was only recoverable from the audit trail, and backfilling
--    a guess would fabricate evidence in an ISO-13485 record system.
--
-- 2. `prevent_archived_job_update()` (INV-09) amended:
--    a. OLD.status = 'archived': the ONLY permitted UPDATE is the void
--       ANNOTATION — status -> 'voided' with void_reason/voided_by/voided_at
--       all supplied, and EVERY other column byte-identical (compared via
--       to_jsonb minus exactly the annotation columns, so any newly added
--       column is protected by default). The double-signed record content
--       is never editable; void adds state ABOUT the record, never edits it.
--    b. OLD.status = 'voided': immutable, unconditionally. VOIDED had no
--       DB backstop before (system-review SYS-18's "resurrected voided
--       record" race) — a voided job (pre- OR post-archive void) now
--       accepts no UPDATE at all at the database layer.
ALTER TABLE "job" ADD COLUMN "voided_at" timestamptz;

CREATE OR REPLACE FUNCTION prevent_archived_job_update() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'voided' THEN
    RAISE EXCEPTION 'job % is voided and immutable (INV-09 / slice 17)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'archived' THEN
    IF NEW."status" = 'voided'
       AND NEW."void_reason" IS NOT NULL
       AND NEW."voided_by" IS NOT NULL
       AND NEW."voided_at" IS NOT NULL
       AND (to_jsonb(OLD) - ARRAY['status','void_reason','voided_by','voided_at','updated_at'])
         = (to_jsonb(NEW) - ARRAY['status','void_reason','voided_by','voided_at','updated_at'])
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'job % is archived and immutable (INV-09) — the only permitted change is the void annotation (status -> voided with reason/actor/timestamp, all record content byte-identical)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
