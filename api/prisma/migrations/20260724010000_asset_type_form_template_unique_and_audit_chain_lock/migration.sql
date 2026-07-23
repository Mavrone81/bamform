-- BamForm — slice-1 review fixes (Important #1 and #2). Forward-only,
-- does not edit 20260723175620_init or 20260723180000_invariants.
--
-- Reversal:
--   DROP INDEX "asset_type_form_template_id_key";
--   CREATE OR REPLACE FUNCTION compute_audit_event_hash_chain() RETURNS trigger AS $$
--     -- the body from 20260723180000_invariants, i.e. this file's version
--     -- minus the PERFORM pg_advisory_xact_lock(...) line at the top.
--   $$ LANGUAGE plpgsql;

-- ============================================================ Fix 1 (Important)
--
-- DBD §6 ERD: `ASSET_TYPE ||--|| FORM_TEMPLATE : "governed by"` is 1:1 — "one
-- template per type" (§6.7 data dictionary). The implementer correctly
-- resolved the documented circular-FK contradiction (§6.7 vs §6.9) by
-- dropping `form_template.asset_type_id` and keeping `asset_type.
-- form_template_id` as the sole FK, but left it as a plain (non-unique) FK,
-- which silently permits N asset_type rows to share one form_template_id —
-- i.e. N:1, not the ERD's 1:1. A unique index on the remaining FK column is
-- sufficient to enforce 1:1 through that single direction.
CREATE UNIQUE INDEX "asset_type_form_template_id_key" ON "asset_type"("form_template_id");

-- ============================================================ Fix 2 (Important)
--
-- INV-10's hash-chain trigger (`compute_audit_event_hash_chain`, added in
-- 20260723180000_invariants) read the previous row via
-- `ORDER BY "sequence" DESC LIMIT 1` with no row lock. Two concurrent
-- `audit_event` inserts can both read the same "last" row before either
-- commits, compute siblings off the same prev_hash, and fork the chain —
-- exactly the failure mode INV-10 exists to prevent.
--
-- Fix: take a transaction-scoped Postgres advisory lock
-- (`pg_advisory_xact_lock`) keyed on a fixed constant, before reading the
-- previous row. Advisory locks are session/transaction cooperative locks,
-- not tied to any row or table, so this serialises every audit_event INSERT
-- across the whole database onto one lock: the second concurrent inserting
-- transaction blocks at the PERFORM until the first commits or rolls back
-- (releasing the xact-scoped lock automatically), at which point it re-reads
-- the now-committed last row and links correctly. Content/hash computation
-- is otherwise byte-for-byte identical to the original function.
--
-- One more thing has to move inside the locked section: "sequence"
-- (BIGSERIAL). Its nextval() previously ran as an ordinary column default,
-- which Postgres evaluates *before* BEFORE-ROW triggers fire — i.e. before
-- the advisory lock is even attempted. Under concurrency this decouples the
-- numeric sequence value from true commit order (a transaction can be
-- granted a *lower* sequence number than a sibling that goes on to commit
-- *earlier*), which silently breaks `ORDER BY "sequence" DESC LIMIT 1` as a
-- way to find "the row actually last linked into the chain" — verified by a
-- failing run of I-INV-10b during development of this fix (advisory lock
-- alone was not sufficient: it prevented two transactions from reading the
-- exact same prev_hash, but a third transaction could still pick the wrong
-- parent because a lower-sequence row committed after a higher-sequence
-- one). Re-drawing "sequence" from the same underlying sequence object
-- *after* the lock is acquired ties its numeric order to lock-acquisition
-- (and therefore commit) order, which restores `ORDER BY "sequence" DESC` as
-- a valid proxy for chain order. The value nextval() assigned via the column
-- default is simply discarded (a harmless gap — BIGSERIAL/sequences are not
-- guaranteed gapless).
CREATE OR REPLACE FUNCTION compute_audit_event_hash_chain() RETURNS trigger AS $$
DECLARE
  v_prev_hash bytea;
  v_content text;
BEGIN
  -- Serialise concurrent chain writers on a single advisory lock so no two
  -- transactions can read "the last row" before one of them commits.
  PERFORM pg_advisory_xact_lock(hashtext('audit_event_chain'));

  -- Re-draw the sequence number here (see comment above): this ties its
  -- order to lock-acquisition/commit order, not to whenever the column
  -- default happened to run.
  NEW."sequence" := nextval(pg_get_serial_sequence('audit_event', 'sequence'));

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

-- Trigger declaration is unchanged (still BEFORE INSERT, same function name)
-- so no DROP/CREATE TRIGGER is needed — CREATE OR REPLACE FUNCTION above
-- takes effect for the existing "audit_event_hash_chain_trg" immediately.
