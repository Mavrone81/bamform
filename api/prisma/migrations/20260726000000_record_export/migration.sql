-- BamForm — slice 12 (PDF render, archive search, export, reports). Forward-
-- only, additive: one new enum, one new table, one new FK. Does not edit any
-- prior migration.
--
-- Reversal:
--   ALTER TABLE "app_user" DISABLE TRIGGER ALL; -- not required, no triggers on app_user reference this table
--   ALTER TABLE "record_export" DROP CONSTRAINT "record_export_requested_by_fkey";
--   DROP TABLE "record_export";
--   DROP TYPE "record_export_status_t";

-- CreateEnum
CREATE TYPE "record_export_status_t" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "record_export" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "requested_by" UUID NOT NULL,
    "status" "record_export_status_t" NOT NULL,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "filter_json" JSONB,
    "object_key" TEXT,
    "failed_reason" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "record_export_requested_by_created_at_idx" ON "record_export"("requested_by", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "record_export" ADD CONSTRAINT "record_export_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
