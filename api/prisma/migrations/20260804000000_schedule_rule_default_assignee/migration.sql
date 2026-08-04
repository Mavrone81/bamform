-- Slice 32-PLANNERJOB — who normally does this machine's PM.
-- Additive, NULLABLE, no backfill. Forward-only; edits no prior migration.
--
-- Reversal:
--   ALTER TABLE "schedule_rule" DROP CONSTRAINT "schedule_rule_default_assignee_id_fkey";
--   DROP INDEX "schedule_rule_default_assignee_id_idx";
--   ALTER TABLE "schedule_rule" DROP COLUMN "default_assignee_id";
--
-- Reversing is safe for every row already in the system and for every job
-- already generated: nothing else reads this column, `job.assigned_to` is
-- written as a COPY at generation time (never a reference back to here), and
-- no signed record content includes it — so no `content_hash` and no
-- `GET /records/{id}/integrity` answer can change. What it LOSES is the
-- standing assignments themselves: after reversal every rule generates
-- unassigned jobs again, exactly as it did before this migration, and a
-- planner has to assign each generated job by hand. Check before reversing:
--   SELECT count(*) FROM "schedule_rule" WHERE "default_assignee_id" IS NOT NULL;
--
-- ---------------------------------------------------------------- why here
--
-- `schedule_rule` had no assignee of any kind, and `JobGenerationService`
-- never set `job.assigned_to`, so EVERY job the scheduler has ever created
-- arrived unassigned — and a MAINTAINER only ever sees jobs assigned to them
-- (`job-access.ts`), so an unassigned job is invisible to the person who
-- should do it. With 76 machines and 220 rules that is ~220 manual
-- assignments a year on top of the 195 jobs sitting unassigned today.
--
-- The owner: "when planner create a plan maintenance it should allow the
-- assigning or change assigning later." That is TWO levels, and this column
-- is the first: the STANDING assignee for a schedule. The second — reassign
-- one occurrence because that person is on leave — already exists as
-- `job.assigned_to` via `POST /jobs/{jobId}/assign`.
--
-- IT IS A DEFAULT, NOT A LOCK, and the independence is structural rather
-- than merely intended:
--   * `POST /jobs/{jobId}/assign` writes `job.assigned_to` and never touches
--     this column, so reassigning an occurrence cannot silently rewrite the
--     plan.
--   * `PUT /schedule/{scheduleRuleId}/default-assignee` writes this column
--     and never touches `job`, so changing the plan cannot silently move work
--     already generated and possibly already started.
--
-- ------------------------------------------------- why the FK is the only
-- ------------------------------------------------- constraint here
--
-- Assignability (ACTIVE user, holding a result-recording role
-- MAINTAINER/TEAM_LEADER/ENGINEER, whose `user_area_scope` reaches the
-- machine's area) spans three other tables AND changes after the fact — a
-- technician leaves, a role grant is revoked, an area scope is narrowed. A
-- CHECK constraint cannot express it and a trigger enforcing it would make
-- deactivating a user fail on unrelated rows.
--
-- So it is checked at the two moments it can be acted on:
--   * WRITE time (`PUT .../default-assignee`) — 422, the planner picks again.
--   * GENERATION time (`job-generation.service.ts`) — the job is STILL
--     generated, unassigned, and the audit event for that job records
--     `defaultAssigneeUnavailable` with the id that failed. Refusing to
--     generate would be worse: the job IS the controlled record, and a plant
--     that stops raising PM records because someone left the company has an
--     ISO problem, not a staffing one. Silence would be worse still, which is
--     why the trace is in the audit chain and in the sweep's own counters.
--
-- ON DELETE / ON UPDATE are deliberately absent, which in Postgres means
-- NO ACTION on both — NOT `RESTRICT`, which an earlier draft of this comment
-- claimed. The two differ: RESTRICT refuses immediately, NO ACTION defers to
-- the end of the statement and so permits a delete-and-reinsert inside one
-- statement. Neither is reachable here: `app_user` has no delete path
-- anywhere in this system (INV-16 / `grants.sql` revokes DELETE on every
-- table), so a dangling default cannot arise. Deactivation is the removal
-- mechanism, and a deactivated user simply fails the eligibility check above.
--
-- KNOWN, ACCEPTED DRIFT from `schema.prisma`: the relation there is declared
-- without an explicit `onDelete`, and Prisma's default for an OPTIONAL
-- relation is `SetNull` (`onUpdate: Cascade`), so `prisma migrate diff` will
-- report this constraint as differing from the schema. Left as-is
-- deliberately rather than "fixed" in either direction: changing the FK on a
-- live table is a lock this feature does not need, and `SetNull` would
-- silently erase a standing assignment on a delete that cannot happen. If the
-- drift is ever resolved, resolve it by pinning the schema to the database
-- (`onDelete: NoAction, onUpdate: NoAction`), not the reverse.

ALTER TABLE "schedule_rule"
  ADD COLUMN "default_assignee_id" uuid;

ALTER TABLE "schedule_rule"
  ADD CONSTRAINT "schedule_rule_default_assignee_id_fkey"
  FOREIGN KEY ("default_assignee_id") REFERENCES "app_user"("id");

-- Supports "which schedules is this person the standing assignee for", which
-- is what an admin needs before deactivating them. `schedule_rule` holds 220
-- rows, so a plain (non-CONCURRENT) index is correct here — see
-- `scripts/ci/assert-concurrent-indexes.sh` for the large tables that are not.
CREATE INDEX "schedule_rule_default_assignee_id_idx"
  ON "schedule_rule" ("default_assignee_id");
