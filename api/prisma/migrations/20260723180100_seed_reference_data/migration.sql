-- Reversal: DELETE FROM approval_stage_role; DELETE FROM approval_stage;
-- DELETE FROM approval_route WHERE code = 'SINGLE_STAGE_TL_OR_ENG';
-- DELETE FROM role WHERE code IN
--   ('MAINTAINER','TEAM_LEADER','ENGINEER','DOC_CONTROLLER','ADMIN','AUDITOR');
--
-- PR-DBD-09 — role and approval_route are seeded by migration, not manual
-- insertion (DBD §11). Enumerations are seeded by the CREATE TYPE statements
-- in the init migration. The twelve source templates are explicitly NOT
-- seeded here (PR-DBD-10) — that is BAMFORM-TLP-001's separate, auditable,
-- verified load process.
--
-- Idempotent on re-run per DBD §10.1: ON CONFLICT DO NOTHING everywhere a
-- unique code already identifies the row.

INSERT INTO "role" ("code", "name", "description") VALUES
  ('MAINTAINER', 'Maintainer', 'Performs preventive maintenance and records results'),
  ('TEAM_LEADER', 'Team Leader', 'Workshop team leader — verifies completed records'),
  ('ENGINEER', 'Engineer', 'Engineer — verifies completed records; alternate to Team Leader'),
  ('DOC_CONTROLLER', 'Document Controller', 'Authors and manages template revisions'),
  ('ADMIN', 'Administrator', 'System administration'),
  ('AUDITOR', 'Auditor', 'Read-only access to the full audit trail')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "approval_route" ("code", "name", "active") VALUES
  ('SINGLE_STAGE_TL_OR_ENG', 'Single-stage: Team Leader or Engineer', true)
ON CONFLICT ("code") DO NOTHING;

-- Delivered configuration (PR-071): one route, one stage, satisfied by
-- TEAM_LEADER or ENGINEER. No escalation is configured by this seed —
-- delivered config does not specify an escalation target, and UR-050 makes
-- NULL escalation_hours the "no escalation" state.
INSERT INTO "approval_stage" ("approval_route_id", "stage_ordinal", "label", "escalation_hours", "escalate_to_role_id")
SELECT ar."id", 1, 'Verified By (Workshop Team Leader / Engineer)', NULL, NULL
FROM "approval_route" ar
WHERE ar."code" = 'SINGLE_STAGE_TL_OR_ENG'
  AND NOT EXISTS (
    SELECT 1 FROM "approval_stage" s
    WHERE s."approval_route_id" = ar."id" AND s."stage_ordinal" = 1
  );

INSERT INTO "approval_stage_role" ("approval_stage_id", "role_id")
SELECT s."id", r."id"
FROM "approval_stage" s
JOIN "approval_route" ar ON ar."id" = s."approval_route_id" AND ar."code" = 'SINGLE_STAGE_TL_OR_ENG'
JOIN "role" r ON r."code" IN ('TEAM_LEADER', 'ENGINEER')
ON CONFLICT ("approval_stage_id", "role_id") DO NOTHING;

-- UR-076 / DBD §10.1: data migrations that touch records write an
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
    'migration', '20260723180100_seed_reference_data',
    'seeded', jsonb_build_array(
      'role: MAINTAINER, TEAM_LEADER, ENGINEER, DOC_CONTROLLER, ADMIN, AUDITOR',
      'approval_route: SINGLE_STAGE_TL_OR_ENG (1 stage, TEAM_LEADER or ENGINEER)'
    )
  )
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_event"
  WHERE "entity_type" = 'system' AND "after"->>'migration' = '20260723180100_seed_reference_data'
);
