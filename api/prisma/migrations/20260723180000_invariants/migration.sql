-- BamForm — DBD §7 invariants and §8 partial/BRIN indexes that Prisma's
-- schema DSL cannot express (no partial-index / no-trigger support).
--
-- Reversal: additive only (constraints, triggers, indexes) — reversal is
-- `DROP TRIGGER/FUNCTION/INDEX/CONSTRAINT ...` for each object below, or
-- restore from the pre-migration pg_dump (PR-DBD-07/08).
--
-- pgcrypto is required for digest() used by the audit hash-chain trigger
-- (PRD §4 notes pgcrypto is already available for field encryption).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================ CHECK constraints

-- INV-03 — approver differs from author (UR-014, PR-047)
ALTER TABLE "template_revision"
  ADD CONSTRAINT "template_revision_approver_not_author_chk"
  CHECK ("approved_by" IS NULL OR "approved_by" <> "authored_by");

-- INV-04 — specification limits are ordered (UR-019, PR-027, defect B-04)
ALTER TABLE "template_measurement"
  ADD CONSTRAINT "template_measurement_limits_ordered_chk"
  CHECK ("lower_limit" IS NULL OR "upper_limit" IS NULL OR "lower_limit" <= "upper_limit");

-- INV-12 — void requires a reason of at least 10 characters (UR-054, PR-046)
ALTER TABLE "job"
  ADD CONSTRAINT "job_void_reason_length_chk"
  CHECK ("status" <> 'voided' OR length("void_reason") >= 10);

-- INV-13 — return requires a reason of at least 10 characters (UR-047, PR-074)
ALTER TABLE "approval_step"
  ADD CONSTRAINT "approval_step_return_reason_length_chk"
  CHECK ("action" <> 'returned' OR length("reason") >= 10);

-- INV-14 — delegation window is valid (UR-052)
ALTER TABLE "delegation"
  ADD CONSTRAINT "delegation_window_chk"
  CHECK ("valid_to" > "valid_from");

-- ==================================================================== Triggers

-- INV-02 — revision sequence has no gaps (UR-010, PR-024, defect B-02).
-- BEFORE INSERT only, matching DBD §7's stated mechanism ("Trigger on insert").
CREATE FUNCTION enforce_revision_sequence_contiguity() RETURNS trigger AS $$
DECLARE
  expected_next integer;
BEGIN
  SELECT COALESCE(MAX("sequence_ordinal"), -1) + 1
    INTO expected_next
    FROM "template_revision"
    WHERE "form_template_id" = NEW."form_template_id";

  IF NEW."sequence_ordinal" <> expected_next THEN
    RAISE EXCEPTION
      'template_revision.sequence_ordinal must be contiguous: expected %, got % (form_template_id=%)',
      expected_next, NEW."sequence_ordinal", NEW."form_template_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "template_revision_sequence_contiguity_trg"
  BEFORE INSERT ON "template_revision"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_revision_sequence_contiguity();

-- INV-05 — verifier differs from submitter (UR-045, PR-044). DBD §7 states the
-- mechanism as "CHECK on approval_step joined to job.submitted_by via
-- trigger" — a plain CHECK cannot reference another table, hence the trigger.
CREATE FUNCTION enforce_verifier_not_submitter() RETURNS trigger AS $$
DECLARE
  v_submitted_by uuid;
BEGIN
  IF NEW."action" = 'verified' THEN
    SELECT "submitted_by" INTO v_submitted_by FROM "job" WHERE "id" = NEW."job_id";

    IF v_submitted_by IS NOT NULL AND v_submitted_by = NEW."actor_id" THEN
      RAISE EXCEPTION
        'approval_step: verifier (actor_id=%) must differ from submitter (job.submitted_by)',
        NEW."actor_id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "approval_step_verifier_not_submitter_trg"
  BEFORE INSERT ON "approval_step"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_verifier_not_submitter();

-- INV-09 — archived jobs are immutable (UR-055, PR-041)
CREATE FUNCTION prevent_archived_job_update() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'archived' THEN
    RAISE EXCEPTION 'job % is archived and immutable (INV-09)', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "job_archived_immutable_trg"
  BEFORE UPDATE ON "job"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_archived_job_update();

-- INV-10 — audit chain unbroken (UR-077, PR-097). The hash is always
-- server-computed from the row content and the previous row's hash; any
-- client-supplied prev_hash/hash is overwritten (BEFORE INSERT wins).
--
-- KNOWN LIMITATION (documented, not fixed in this slice): this does not take
-- an explicit lock, so two concurrent audit_event inserts could both read the
-- same "last" row and compute siblings off the same prev_hash. Serialising
-- concurrent writers is deferred to slice 8 (daily chain verification worker,
-- PR-097's scheduled check). It does not affect I-INV-11 (single transaction,
-- audit insert fails => the whole transaction rolls back).
CREATE FUNCTION compute_audit_event_hash_chain() RETURNS trigger AS $$
DECLARE
  v_prev_hash bytea;
  v_content text;
BEGIN
  SELECT "hash" INTO v_prev_hash FROM "audit_event" ORDER BY "sequence" DESC LIMIT 1;

  NEW."prev_hash" := v_prev_hash;

  v_content := concat_ws('|',
    NEW."id"::text,
    NEW."occurred_at"::text,
    coalesce(NEW."actor_id"::text, ''),
    coalesce(NEW."on_behalf_of_id"::text, ''),
    NEW."action"::text,
    NEW."entity_type",
    coalesce(NEW."entity_id"::text, ''),
    coalesce(NEW."before"::text, ''),
    coalesce(NEW."after"::text, ''),
    coalesce(host(NEW."source_ip"), ''),
    coalesce(NEW."request_id", ''),
    coalesce(encode(v_prev_hash, 'hex'), '')
  );

  NEW."hash" := digest(v_content, 'sha256');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_event_hash_chain_trg"
  BEFORE INSERT ON "audit_event"
  FOR EACH ROW
  EXECUTE FUNCTION compute_audit_event_hash_chain();

-- ============================================== Partial / BRIN indexes (§8)
-- (job/audit_event partial+BRIN indexes are CONCURRENTLY, each in its own
-- single-statement migration per assert-concurrent-indexes.sh / M-06 — see
-- the migrations that follow this one.)

-- INV-01 — one current revision per template (UR-012, PR-023)
CREATE UNIQUE INDEX "template_revision_one_current_per_template_uidx"
  ON "template_revision" ("form_template_id")
  WHERE "status" = 'current';

-- Scheduler sweep (PR-050)
CREATE INDEX "schedule_rule_next_due_on_active_idx"
  ON "schedule_rule" ("next_due_on")
  WHERE "active";

-- Area-scoped access (PR-073)
CREATE INDEX "asset_area_id_active_idx"
  ON "asset" ("area_id")
  WHERE "active";

-- Refresh-token family revocation on reuse
CREATE INDEX "refresh_token_family_id_active_idx"
  ON "refresh_token" ("family_id")
  WHERE "revoked_at" IS NULL;

-- Request-time delegation resolution
CREATE INDEX "delegation_delegate_active_idx"
  ON "delegation" ("delegate_id", "valid_from", "valid_to")
  WHERE "revoked_at" IS NULL;

-- Idempotency-key expiry sweep — BRIN (append-only, time-correlated, §8 note)
CREATE INDEX "idempotency_key_expires_at_brin_idx"
  ON "idempotency_key" USING BRIN ("expires_at");
