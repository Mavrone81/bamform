-- Reversal:
--   ALTER TABLE "job" DROP CONSTRAINT "job_adhoc_reason_length_chk";
--   DELETE FROM "user_role" WHERE "role_id" = (SELECT id FROM "role" WHERE code = 'PLANNER');
--   DELETE FROM "role" WHERE "code" = 'PLANNER';
--   DELETE FROM "audit_event"
--     WHERE "entity_type" = 'system'
--       AND "after"->>'migration' = '20260728020000_planner_role_and_adhoc_job';
--   (audit_event is append-only for bamform_app — the DELETE above is a
--   DBA/superuser action, exactly like the seed migration's own reversal.)
--
-- Slice 18-WORKFLOW — the owner described the plant's real working process on
-- 2026-07-28. Two of its pieces have no database representation yet:
--
--  1. A dedicated PLANNING role. Decision (owner, 2026-07-28): the code is
--     `PLANNER`, NOT "SCHEDULER" — that word already names the background
--     worker (`api/src/scheduling/scheduler.service.ts`), and the collision
--     would poison logs and conversation. Permissions are ADDITIVE: PLANNER
--     gains schedule planning, ad-hoc raising and assignment; TEAM_LEADER,
--     ENGINEER and ADMIN keep every right they hold today. Nobody loses
--     access. Seeded here, idempotently, following
--     20260723180100_seed_reference_data's `ON CONFLICT DO NOTHING` pattern
--     (PR-DBD-09: role is seeded by migration, never by hand).
--
--     PLANNER is deliberately NOT added to any `approval_stage_role` —
--     separation of duties: planning work and verifying it are different
--     jobs. A person who genuinely does both holds both roles, and the
--     distinct-person rule (SYS-8 / `approval_step_distinct_stage_verifiers_trg`)
--     still forbids one human signing both verification stages.
--
--  2. UR-028 ad-hoc jobs, whose `is_adhoc`/`adhoc_reason` columns have
--     existed since 20260723175620_init but were never written by anything.
--     The reason is MANDATORY (UR-028: "with a recorded reason") and is now
--     enforced by the DATABASE, not the service alone — the same
--     service-AND-database discipline INV-12 (void reason) and INV-13
--     (return reason) already use, and the same >= 10 character threshold.

INSERT INTO "role" ("code", "name", "description") VALUES
  ('PLANNER', 'Planner', 'Maintenance planner — plans the PM schedule and raises work')
ON CONFLICT ("code") DO NOTHING;

-- Mirrors "job_void_reason_length_chk" (INV-12) exactly in shape. Existing
-- rows are all `is_adhoc = false` (nothing has ever written the column), so
-- this cannot fail on current data.
ALTER TABLE "job"
  ADD CONSTRAINT "job_adhoc_reason_length_chk"
  CHECK ("is_adhoc" = false OR length("adhoc_reason") >= 10);

-- UR-076 / DBD §10.1: a data migration that touches records writes an
-- audit_event. actor_id is NULL — a system/migration action, not a user.
-- Guarded by NOT EXISTS so re-running this migration stays idempotent.
INSERT INTO "audit_event" ("occurred_at", "actor_id", "action", "entity_type", "entity_id", "after")
SELECT
  now(),
  NULL,
  'create',
  'system',
  NULL,
  jsonb_build_object(
    'migration', '20260728020000_planner_role_and_adhoc_job',
    'seeded', jsonb_build_array(
      'role: PLANNER (additive — no existing role loses any right)'
    ),
    'constraints', jsonb_build_array(
      'job_adhoc_reason_length_chk: an ad-hoc job carries a reason of >= 10 characters (UR-028)'
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_event"
  WHERE "entity_type" = 'system'
    AND "after"->>'migration' = '20260728020000_planner_role_and_adhoc_job'
);
