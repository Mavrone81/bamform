-- BamForm — initial schema. BAMFORM-DBD-001 §6 (Data Dictionary), §5 (Enumerations).
--
-- Reversal: this is the first migration against an empty database — reversal
-- is `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (nothing to preserve).
-- On a live system the general reversal is "restore from the pre-migration
-- pg_dump taken by the deploy script" (PR-DBD-07/08).
--
-- uuidv7() — Postgres 16 has no native uuidv7() (that lands in PG 18). This
-- is the widely-used pure-SQL implementation: start from gen_random_uuid()
-- (a v4 UUID, core function since PG 13), overlay the low 48 bits of the
-- current unix time in milliseconds over its first 6 bytes, then set bits
-- 52/53 so the version nibble (RFC 9562 octet 6, bits 48-51) reads 0111 (7).
-- The variant bits (octet 8) are left untouched — gen_random_uuid() already
-- sets the correct RFC 4122 variant and overlay() never touches byte 8.
-- Referenced as every table's `id` default (DP-9).
CREATE FUNCTION uuidv7() RETURNS uuid
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid()) placing
          substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

-- CreateEnum
CREATE TYPE "frequency_t" AS ENUM ('M1', 'M3', 'M6', 'Y');

-- CreateEnum
CREATE TYPE "asset_status_t" AS ENUM ('active', 'under_repair', 'decommissioned');

-- CreateEnum
CREATE TYPE "revision_status_t" AS ENUM ('draft', 'pending_approval', 'current', 'superseded', 'rejected');

-- CreateEnum
CREATE TYPE "job_status_t" AS ENUM ('scheduled', 'assigned', 'in_progress', 'submitted', 'verified', 'archived', 'voided');

-- CreateEnum
CREATE TYPE "item_status_t" AS ENUM ('done', 'not_applicable', 'not_done');

-- CreateEnum
CREATE TYPE "spec_type_t" AS ENUM ('range', 'tolerance', 'pass_fail', 'text');

-- CreateEnum
CREATE TYPE "judgement_t" AS ENUM ('pass', 'fail', 'not_evaluated');

-- CreateEnum
CREATE TYPE "approval_action_t" AS ENUM ('submitted', 'verified', 'returned', 'recalled', 'voided', 'revision_approved', 'revision_rejected');

-- CreateEnum
CREATE TYPE "user_status_t" AS ENUM ('active', 'suspended', 'deactivated');

-- CreateEnum
CREATE TYPE "notification_channel_t" AS ENUM ('email', 'in_app');

-- CreateEnum
CREATE TYPE "notification_state_t" AS ENUM ('queued', 'sent', 'failed', 'read');

-- CreateEnum
CREATE TYPE "audit_action_t" AS ENUM ('create', 'update', 'state_change', 'approve', 'reject', 'void', 'login', 'login_failed', 'permission_change', 'key_rotation', 'export');

-- CreateTable
CREATE TABLE "area" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "employee_id_ct" BYTEA,
    "employee_id_bidx" BYTEA,
    "full_name_ct" BYTEA NOT NULL,
    "email_ct" BYTEA NOT NULL,
    "email_bidx" BYTEA NOT NULL,
    "password_hash" TEXT,
    "password_changed_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "last_authenticated_at" TIMESTAMPTZ(6),
    "status" "user_status_t" NOT NULL DEFAULT 'active',
    "deactivated_at" TIMESTAMPTZ(6),
    "dek_version" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "user_area_scope" (
    "user_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,

    CONSTRAINT "user_area_scope_pkey" PRIMARY KEY ("user_id","area_id")
);

-- CreateTable
CREATE TABLE "delegation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "delegator_id" UUID NOT NULL,
    "delegate_id" UUID NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "created_by" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "user_agent" TEXT,
    "source_ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_type" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "form_template_id" UUID NOT NULL,
    "approval_route_id" UUID NOT NULL,
    "lead_time_days" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "asset_type_id" UUID NOT NULL,
    "description" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "area_id" UUID,
    "location_detail" TEXT,
    "commissioned_on" DATE,
    "schedule_anchor_date" DATE NOT NULL,
    "status" "asset_status_t" NOT NULL DEFAULT 'active',
    "decommissioned_on" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_template" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "document_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_revision" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "form_template_id" UUID NOT NULL,
    "revision_code" TEXT NOT NULL,
    "sequence_ordinal" INTEGER NOT NULL,
    "status" "revision_status_t" NOT NULL,
    "change_description" TEXT NOT NULL,
    "standing_content" JSONB NOT NULL,
    "authored_by" UUID NOT NULL,
    "authored_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "rejected_reason" TEXT,
    "effective_from" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_item" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "template_revision_id" UUID NOT NULL,
    "item_no" INTEGER NOT NULL,
    "frequency" "frequency_t" NOT NULL,
    "instruction" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "stable_key" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_measurement" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "template_revision_id" UUID NOT NULL,
    "section" TEXT,
    "description" TEXT NOT NULL,
    "unit" TEXT,
    "spec_type" "spec_type_t" NOT NULL,
    "lower_limit" DECIMAL(18,6),
    "upper_limit" DECIMAL(18,6),
    "nominal" DECIMAL(18,6),
    "tolerance" DECIMAL(18,6),
    "spec_display" TEXT NOT NULL,
    "stable_key" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_measurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_route" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_stage" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "approval_route_id" UUID NOT NULL,
    "stage_ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "escalation_hours" INTEGER,
    "escalate_to_role_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_stage_role" (
    "approval_stage_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "approval_stage_role_pkey" PRIMARY KEY ("approval_stage_id","role_id")
);

-- CreateTable
CREATE TABLE "schedule_rule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "asset_id" UUID NOT NULL,
    "frequency" "frequency_t" NOT NULL,
    "interval_months" INTEGER NOT NULL,
    "anchor_date" DATE NOT NULL,
    "last_completed_on" DATE,
    "next_due_on" DATE NOT NULL,
    "adjusted_reason" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_number" TEXT NOT NULL,
    "asset_id" UUID NOT NULL,
    "template_revision_id" UUID NOT NULL,
    "approval_route_id" UUID NOT NULL,
    "frequency" "frequency_t" NOT NULL,
    "frequency_scope" "frequency_t"[],
    "due_on" DATE NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL,
    "is_adhoc" BOOLEAN NOT NULL DEFAULT false,
    "adhoc_reason" TEXT,
    "assigned_to" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "status" "job_status_t" NOT NULL,
    "current_stage_ordinal" INTEGER,
    "started_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,
    "voided_by" UUID,
    "draft_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_result" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "template_item_id" UUID NOT NULL,
    "status" "item_status_t" NOT NULL,
    "remark" TEXT,
    "recorded_by" UUID NOT NULL,
    "client_recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_result" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "template_measurement_id" UUID NOT NULL,
    "reading_numeric" DECIMAL(18,6),
    "reading_text" TEXT,
    "judgement" "judgement_t" NOT NULL DEFAULT 'not_evaluated',
    "remark" TEXT,
    "recorded_by" UUID NOT NULL,
    "client_recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_used" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "part_no" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "remarks" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "part_used_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "item_result_id" UUID,
    "object_key" TEXT NOT NULL,
    "original_filename" TEXT,
    "content_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL,
    "upload_state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_step" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "stage_ordinal" INTEGER NOT NULL,
    "action" "approval_action_t" NOT NULL,
    "actor_id" UUID NOT NULL,
    "on_behalf_of_id" UUID,
    "actor_role_code" TEXT NOT NULL,
    "reason" TEXT,
    "acted_at" TIMESTAMPTZ(6) NOT NULL,
    "source_ip" INET,
    "content_hash" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "signing_key_id" TEXT NOT NULL,
    "step_up_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "sequence" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_id" UUID,
    "on_behalf_of_id" UUID,
    "action" "audit_action_t" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "source_ip" INET,
    "request_id" TEXT,
    "prev_hash" BYTEA,
    "hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "recipient_id" UUID NOT NULL,
    "channel" "notification_channel_t" NOT NULL,
    "template_code" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "payload" JSONB NOT NULL,
    "state" "notification_state_t" NOT NULL,
    "queued_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "failed_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_fingerprint" BYTEA NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "area_code_key" ON "area"("code");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_bidx_key" ON "app_user"("email_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "role_code_key" ON "role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "asset_type_code_key" ON "asset_type"("code");

-- CreateIndex
CREATE UNIQUE INDEX "asset_code_key" ON "asset"("code");

-- CreateIndex
CREATE INDEX "asset_asset_type_id_status_idx" ON "asset"("asset_type_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "form_template_document_number_key" ON "form_template"("document_number");

-- CreateIndex
CREATE UNIQUE INDEX "template_revision_form_template_id_sequence_ordinal_key" ON "template_revision"("form_template_id", "sequence_ordinal");

-- CreateIndex
CREATE INDEX "template_item_template_revision_id_display_order_idx" ON "template_item"("template_revision_id", "display_order");

-- CreateIndex
CREATE INDEX "template_item_template_revision_id_frequency_idx" ON "template_item"("template_revision_id", "frequency");

-- CreateIndex
CREATE INDEX "template_measurement_template_revision_id_display_order_idx" ON "template_measurement"("template_revision_id", "display_order");

-- CreateIndex
CREATE INDEX "template_measurement_stable_key_idx" ON "template_measurement"("stable_key");

-- CreateIndex
CREATE UNIQUE INDEX "approval_route_code_key" ON "approval_route"("code");

-- CreateIndex
CREATE UNIQUE INDEX "approval_stage_approval_route_id_stage_ordinal_key" ON "approval_stage"("approval_route_id", "stage_ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_rule_asset_id_frequency_key" ON "schedule_rule"("asset_id", "frequency");

-- CreateIndex
CREATE INDEX "approval_step_actor_id_acted_at_idx" ON "approval_step"("actor_id", "acted_at" DESC);

-- CreateIndex
CREATE INDEX "notification_recipient_id_state_queued_at_idx" ON "notification"("recipient_id", "state", "queued_at" DESC);

-- NOTE: nine indexes Prisma would normally place here (job_job_number_key,
-- job_asset_id_due_on_idx, item_result_job_id_template_item_id_key,
-- measurement_result_template_measurement_id_recorded_at_idx,
-- measurement_result_job_id_template_measurement_id_key,
-- attachment_job_id_idx, approval_step_job_id_acted_at_idx,
-- audit_event_sequence_key, audit_event_entity_type_entity_id_sequence_idx)
-- are relocated instead to the nine single-statement CONCURRENTLY migrations
-- that immediately follow this one. Reason: M-06's checker script scans for
-- lines starting the relevant SQL keywords against a large-table name list,
-- and a column called job_id on ANY table trips that check the same way a
-- table literally named job/audit_event/item_result/measurement_result
-- would — see each of those nine migrations' own header comment.

-- AddForeignKey
ALTER TABLE "area" ADD CONSTRAINT "area_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_area_scope" ADD CONSTRAINT "user_area_scope_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_area_scope" ADD CONSTRAINT "user_area_scope_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_delegator_id_fkey" FOREIGN KEY ("delegator_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_delegate_id_fkey" FOREIGN KEY ("delegate_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_type" ADD CONSTRAINT "asset_type_form_template_id_fkey" FOREIGN KEY ("form_template_id") REFERENCES "form_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_type" ADD CONSTRAINT "asset_type_approval_route_id_fkey" FOREIGN KEY ("approval_route_id") REFERENCES "approval_route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_asset_type_id_fkey" FOREIGN KEY ("asset_type_id") REFERENCES "asset_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_revision" ADD CONSTRAINT "template_revision_form_template_id_fkey" FOREIGN KEY ("form_template_id") REFERENCES "form_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_revision" ADD CONSTRAINT "template_revision_authored_by_fkey" FOREIGN KEY ("authored_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_revision" ADD CONSTRAINT "template_revision_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_item" ADD CONSTRAINT "template_item_template_revision_id_fkey" FOREIGN KEY ("template_revision_id") REFERENCES "template_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_measurement" ADD CONSTRAINT "template_measurement_template_revision_id_fkey" FOREIGN KEY ("template_revision_id") REFERENCES "template_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_approval_route_id_fkey" FOREIGN KEY ("approval_route_id") REFERENCES "approval_route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_stage" ADD CONSTRAINT "approval_stage_escalate_to_role_id_fkey" FOREIGN KEY ("escalate_to_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_stage_role" ADD CONSTRAINT "approval_stage_role_approval_stage_id_fkey" FOREIGN KEY ("approval_stage_id") REFERENCES "approval_stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_stage_role" ADD CONSTRAINT "approval_stage_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_rule" ADD CONSTRAINT "schedule_rule_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_template_revision_id_fkey" FOREIGN KEY ("template_revision_id") REFERENCES "template_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_approval_route_id_fkey" FOREIGN KEY ("approval_route_id") REFERENCES "approval_route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_result" ADD CONSTRAINT "item_result_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_result" ADD CONSTRAINT "item_result_template_item_id_fkey" FOREIGN KEY ("template_item_id") REFERENCES "template_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_result" ADD CONSTRAINT "item_result_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_result" ADD CONSTRAINT "measurement_result_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_result" ADD CONSTRAINT "measurement_result_template_measurement_id_fkey" FOREIGN KEY ("template_measurement_id") REFERENCES "template_measurement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_result" ADD CONSTRAINT "measurement_result_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_used" ADD CONSTRAINT "part_used_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_used" ADD CONSTRAINT "part_used_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_item_result_id_fkey" FOREIGN KEY ("item_result_id") REFERENCES "item_result"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_on_behalf_of_id_fkey" FOREIGN KEY ("on_behalf_of_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_on_behalf_of_id_fkey" FOREIGN KEY ("on_behalf_of_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
