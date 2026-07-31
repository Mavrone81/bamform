-- Slice 30 — soft-remove flag for parts. Additive, nullable-safe via DEFAULT.
ALTER TABLE "part_used" ADD COLUMN "active" boolean NOT NULL DEFAULT true;
