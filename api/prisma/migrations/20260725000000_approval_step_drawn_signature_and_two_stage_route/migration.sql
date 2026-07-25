-- BamForm — slice 7 (approval workflow). Forward-only, additive; does not
-- edit 20260723175620_init, 20260723180000_invariants, or
-- 20260723180100_seed_reference_data.
--
-- Reversal:
--   ALTER TABLE "approval_step" DROP COLUMN "drawn_signature_ct";
--   ALTER TABLE "approval_step" DROP COLUMN "drawn_signature_dek_version";
--   DELETE FROM "approval_stage_role"
--     WHERE "approval_stage_id" IN (
--       SELECT "id" FROM "approval_stage"
--       WHERE "approval_route_id" = (SELECT "id" FROM "approval_route" WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG')
--         AND "stage_ordinal" = 2
--     );
--   DELETE FROM "approval_stage"
--     WHERE "approval_route_id" = (SELECT "id" FROM "approval_route" WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG')
--       AND "stage_ordinal" = 2;
--   INSERT INTO "approval_stage_role" ("approval_stage_id", "role_id")
--     SELECT s."id", r."id" FROM "approval_stage" s, "role" r
--     WHERE s."approval_route_id" = (SELECT "id" FROM "approval_route" WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG')
--       AND s."stage_ordinal" = 1 AND r."code" = 'ENGINEER'
--     ON CONFLICT DO NOTHING;
--   UPDATE "approval_route" SET "name" = 'Single-stage: Team Leader or Engineer'
--     WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG';
--
-- ============================================================ Why
--
-- 1. `approval_step.drawn_signature_ct` / `drawn_signature_dek_version` —
--    slice-7-brief.md "SAMUEL'S CONFIRMED DECISIONS": each verifier signs by
--    DRAWING (stylus/mouse) — the captured PNG is stored on `approval_step`,
--    field-encrypted (personal data — a captured signature image — same
--    AES-256-GCM approach `field-encryption.ts` already uses for `app_user`,
--    extended here to a second table/column for the first time). One
--    `dek_version` per row, matching `app_user`'s convention (not per-field —
--    `approval_step` has only ever this one encrypted column).
--
-- 2. Two-stage approval route — Samuel's confirmed decision (slice-7-brief.md,
--    overriding PRD §8 PR-071/ADR-011's "delivered configuration is a single
--    stage", which predates that confirmation): ALL 12 source documents show
--    two signature blocks (Team Leader AND Supervisor/Engineer). ADR-011
--    designed exactly for this: "reinstating the second signature is two
--    INSERT statements and one UPDATE — no migration [schema change], no code
--    change" — this migration performs precisely that data change, no schema
--    change beyond the drawn-signature columns above. The route's `code`
--    (`SINGLE_STAGE_TL_OR_ENG`) is left untouched — it is a stable identifier
--    referenced by earlier migrations/fixtures/tests, not a live description;
--    `name` is updated to stop it being misleading.
--
--    Before: one stage (ordinal 1), satisfied by TEAM_LEADER **or** ENGINEER.
--    After:  stage 1 satisfied by TEAM_LEADER only; stage 2 (new) satisfied
--            by ENGINEER only — matching the source documents' "Verified By
--            (Team Leader)" then "Verified By (Supervisor/Engineer)" blocks.

ALTER TABLE "approval_step" ADD COLUMN "drawn_signature_ct" BYTEA;
ALTER TABLE "approval_step" ADD COLUMN "drawn_signature_dek_version" SMALLINT;

-- Narrow stage 1 to TEAM_LEADER only (drop the ENGINEER alternative — stage 2
-- now carries it).
DELETE FROM "approval_stage_role"
WHERE "approval_stage_id" IN (
    SELECT s."id" FROM "approval_stage" s
    JOIN "approval_route" ar ON ar."id" = s."approval_route_id" AND ar."code" = 'SINGLE_STAGE_TL_OR_ENG'
    WHERE s."stage_ordinal" = 1
  )
  AND "role_id" = (SELECT "id" FROM "role" WHERE "code" = 'ENGINEER');

-- Add stage 2, satisfied by ENGINEER.
INSERT INTO "approval_stage" ("approval_route_id", "stage_ordinal", "label", "escalation_hours", "escalate_to_role_id")
SELECT ar."id", 2, 'Verified By (Supervisor / Engineer)', NULL, NULL
FROM "approval_route" ar
WHERE ar."code" = 'SINGLE_STAGE_TL_OR_ENG'
  AND NOT EXISTS (
    SELECT 1 FROM "approval_stage" s
    WHERE s."approval_route_id" = ar."id" AND s."stage_ordinal" = 2
  );

INSERT INTO "approval_stage_role" ("approval_stage_id", "role_id")
SELECT s."id", r."id"
FROM "approval_stage" s
JOIN "approval_route" ar ON ar."id" = s."approval_route_id" AND ar."code" = 'SINGLE_STAGE_TL_OR_ENG'
JOIN "role" r ON r."code" = 'ENGINEER'
WHERE s."stage_ordinal" = 2
ON CONFLICT ("approval_stage_id", "role_id") DO NOTHING;

-- Stage 1's label also referred to "Team Leader / Engineer" under the old
-- single-stage config; correct it now that stage 1 is TEAM_LEADER-only.
UPDATE "approval_stage" s
SET "label" = 'Verified By (Workshop Team Leader)'
FROM "approval_route" ar
WHERE s."approval_route_id" = ar."id"
  AND ar."code" = 'SINGLE_STAGE_TL_OR_ENG'
  AND s."stage_ordinal" = 1;

UPDATE "approval_route"
SET "name" = 'Two-stage: Team Leader then Engineer'
WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG';

-- UR-076 / DBD §10.1 — data migrations that touch records write an
-- audit_event; guarded so re-running stays idempotent.
INSERT INTO "audit_event" ("occurred_at", "actor_id", "action", "entity_type", "entity_id", "after")
SELECT
  now(),
  NULL,
  'update',
  'system',
  NULL,
  jsonb_build_object(
    'migration', '20260725000000_approval_step_drawn_signature_and_two_stage_route',
    'changed', jsonb_build_array(
      'approval_step: +drawn_signature_ct, +drawn_signature_dek_version',
      'approval_route SINGLE_STAGE_TL_OR_ENG: reconfigured 1 stage (TL or ENG) -> 2 stages (TL then ENG), per Samuel''s confirmed decision'
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_event"
  WHERE "entity_type" = 'system'
    AND "after"->>'migration' = '20260725000000_approval_step_drawn_signature_and_two_stage_route'
);
