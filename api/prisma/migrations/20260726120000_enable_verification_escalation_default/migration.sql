-- Reversal: UPDATE "approval_stage" SET "escalation_hours" = NULL
--   WHERE "approval_route_id" = (SELECT "id" FROM "approval_route"
--                                WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG');
--   Escalation returns to the inert state; any BullMQ timers already
--   scheduled from the previous config drain harmlessly (the dispatcher
--   re-checks the job's current stage before sending — see
--   notification-dispatch.service.ts:102-118).
--
-- Data-only migration. No DDL, so no schema.prisma change accompanies it.
--
-- UR-050 / PR-077. The escalation MECHANISM shipped in slice 11a (delayed
-- BullMQ job scheduled at submission, cancelled on verify/return/recall/void)
-- but was delivered INERT: both stages of the delivered route carry
-- escalation_hours = NULL, and NULL is deliberately "no escalation for this
-- stage", never "use a system default" (see approval.repository.ts:67-75).
--
-- That left a documented contradiction, flagged for the product owner as
-- slice-11a finding D: docs/ENVIRONMENT_REQUIREMENTS.md:246 advertises
-- VERIFICATION_ESCALATION_HOURS = 72 as the default "overridable per approval
-- stage", while the seed comment declared escalation off. Samuel resolved it
-- on 2026-07-26: escalate at a 72-hour global default.
--
-- Configured as DATA rather than by changing the NULL semantics in code,
-- because routes and their stages are configuration (ADR-011) and four source
-- files document NULL as the explicit off state. Per-stage overrides continue
-- to work exactly as before; an admin may change these values.
--
-- escalate_to_role_id is left NULL on purpose: the payload contract defines a
-- null target as "fall back to whoever is currently eligible to verify this
-- stage" (notification-payloads.ts:24), so an unverified record re-notifies
-- its eligible verifiers after 72h. Pointing a stage at a higher role instead
-- is a single-row config change whenever the plant wants true escalation.
--
-- Inert in production until notifications are switched on: NOTIFICATION_ENABLED
-- is false and the SMTP transport is a no-op until real credentials land.
--
-- Idempotent (PR-RUN-07 / DBD §10.1): the WHERE clause only touches stages
-- still carrying the delivered NULL, so a re-run — or a re-run after an admin
-- has set their own value — changes nothing.

UPDATE "approval_stage"
SET "escalation_hours" = 72
WHERE "escalation_hours" IS NULL
  AND "approval_route_id" = (
    SELECT "id" FROM "approval_route" WHERE "code" = 'SINGLE_STAGE_TL_OR_ENG'
  );
