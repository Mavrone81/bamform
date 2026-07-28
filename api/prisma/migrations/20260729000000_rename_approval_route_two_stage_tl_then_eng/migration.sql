-- BamForm — slice 26-TWOSTAGE. Forward-only, data-only. No DDL, so no
-- schema.prisma change accompanies it.
--
-- Reversal:
--   UPDATE "approval_route" SET "code" = 'SINGLE_STAGE_TL_OR_ENG'
--    WHERE "code" = 'TWO_STAGE_TL_THEN_ENG';
--   (`name` already reads 'Two-stage: Team Leader then Engineer' — set by
--   20260725000000 — and is left alone by this migration and its reversal.)
--
-- ============================================================ Why
--
-- The delivered route has been TWO stages since
-- 20260725000000_approval_step_drawn_signature_and_two_stage_route: stage 1
-- satisfied by TEAM_LEADER only, stage 2 by ENGINEER only. That migration
-- deliberately left the `code` alone, reasoning it was "a stable identifier
-- ... not a live description". Six migrations later the identifier is the
-- single most misleading string in the schema: `SINGLE_STAGE_TL_OR_ENG`
-- names a route that is neither single-stage nor "TL or ENG", and every
-- reader who greps for how approval works meets that name first.
--
-- ISO-13485 §4.2.4 keeps records honest; a control-plane identifier that
-- contradicts the control it names is the same class of defect. Rename it.
--
-- Safe to rename rather than re-key because nothing stores the CODE as a
-- foreign key — `asset_type.approval_route_id` and `job.approval_route_id`
-- reference `approval_route.id` (a uuid), which this migration does not
-- touch. The code is used for lookup only:
--   * scripts/template-load/src/loader.ts  (picks the route when creating an
--     asset type)
--   * api/test/integration/helpers/fixtures.ts (test seed lookup)
-- Both are updated in the same commit. `approval_route_code_key` (UNIQUE,
-- 20260723175620_init) is satisfied: exactly one row changes, to a value no
-- other row holds.
--
-- ADR-011's route-as-data stands — an administrator may still add routes;
-- this only corrects the delivered one's name.
--
-- Idempotent (PR-RUN-07 / DBD §10.1): the WHERE clause matches only the old
-- code, so a re-run — or a run against a database already renamed — is a
-- no-op. It is also a no-op on a database where an administrator has
-- already introduced their own code for this route.

-- UR-076 / DBD §10.1 — data migrations that touch records write an
-- audit_event. TWO guards, and they are guarding different things:
--
--   EXISTS (SELECT 1 FROM renamed)  — the audit row is written only if the
--     UPDATE actually matched. Keying solely on the migration name (the
--     pattern inherited from 20260725000000, which is applied and therefore
--     immutable — the same weakness lives on there) would assert a change on
--     a database where the code had already been altered by other means and
--     the UPDATE matched nothing. An audit trail that records changes which
--     did not happen is worse than one that records none.
--
--   NOT EXISTS (… ->> 'migration' = …) — idempotency (PR-RUN-07 / DBD §10.1):
--     a second run must not append a second row. In practice the first guard
--     already covers the re-run case (the code no longer matches, so nothing
--     is updated), but the two conditions are independent and the invariant
--     "at most one audit row per migration" should not rest on that overlap.
WITH renamed AS (
  UPDATE "approval_route"
  SET "code" = 'TWO_STAGE_TL_THEN_ENG'
  WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG'
  RETURNING 1
)
INSERT INTO "audit_event" ("occurred_at", "actor_id", "action", "entity_type", "entity_id", "after")
SELECT
  now(),
  NULL,
  'update',
  'system',
  NULL,
  jsonb_build_object(
    'migration', '20260729000000_rename_approval_route_two_stage_tl_then_eng',
    'changed', jsonb_build_array(
      'approval_route.code: SINGLE_STAGE_TL_OR_ENG -> TWO_STAGE_TL_THEN_ENG (the route has been two stages, TEAM_LEADER then ENGINEER, since 20260725000000; the code no longer describes it)'
    )
  )
WHERE EXISTS (SELECT 1 FROM renamed)
  AND NOT EXISTS (
    SELECT 1 FROM "audit_event"
    WHERE "entity_type" = 'system'
      AND "after"->>'migration' = '20260729000000_rename_approval_route_two_stage_tl_then_eng'
  );
