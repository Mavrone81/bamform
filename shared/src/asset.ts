import { z } from 'zod';

/**
 * DBD §6.8 `asset.code` — short machine identifier, unique (INV-06, defect B-09),
 * e.g. `AW01`, `BD01`, `EP01`, `IMOS 01` (UR-003).
 */
export const assetCodeSchema = z
  .string()
  .trim()
  .min(1, 'asset code must not be empty')
  .max(50, 'asset code must be 50 characters or fewer');

export type AssetCode = z.infer<typeof assetCodeSchema>;

/** `api/openapi.yaml` `AssetStatus` — mirrors DBD §5 `asset_status_t`. */
export const assetStatusSchema = z.enum(['ACTIVE', 'UNDER_REPAIR', 'DECOMMISSIONED']);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

/** `api/openapi.yaml` `Asset` schema — PR-020. */
export const assetSchema = z.object({
  id: z.string().uuid(),
  code: assetCodeSchema,
  assetTypeId: z.string().uuid(),
  assetTypeName: z.string().optional(),
  description: z.string().nullable().optional(),
  manufacturer: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  serialNumber: z.string().nullable().optional(),
  areaId: z.string().uuid().nullable().optional(),
  locationDetail: z.string().nullable().optional(),
  commissionedOn: z.string().nullable().optional(),
  scheduleAnchorDate: z.string(),
  status: assetStatusSchema,
  active: z.boolean(),
  /**
   * Slice 13a / Samuel's decision (B-09): `true` when `code` was
   * system-generated (the admin did not supply one at creation) and has not
   * yet been confirmed by an admin changing it — the UI renders this "RED".
   * Set `false` the moment an admin edits `code` via `PATCH /assets/{id}`.
   */
  codeProvisional: z.boolean(),
});
export type Asset = z.infer<typeof assetSchema>;

/**
 * `api/openapi.yaml` `AssetCreate` schema. `code` is now OPTIONAL (slice
 * 13a, B-09): if omitted, the server auto-generates one and marks it
 * provisional/"RED" (`assets/machine-code.ts`); if the caller supplies it
 * explicitly, it is treated as already confirmed (`codeProvisional: false`).
 */
export const assetCreateSchema = z.object({
  code: assetCodeSchema.optional(),
  assetTypeId: z.string().uuid(),
  description: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  areaId: z.string().uuid().optional(),
  locationDetail: z.string().optional(),
  commissionedOn: z.string().optional(),
  scheduleAnchorDate: z.string(),
});
export type AssetCreate = z.infer<typeof assetCreateSchema>;

/**
 * `api/openapi.yaml` `AssetUpdate` schema. PR-039/non-negotiable #7: no
 * DELETE — `status`/`active` are the only removal mechanism (deactivation).
 * `code` (slice 13a, B-09): an admin changing it clears `codeProvisional`.
 */
export const assetUpdateSchema = z.object({
  code: assetCodeSchema.optional(),
  description: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  areaId: z.string().uuid().optional(),
  locationDetail: z.string().optional(),
  status: assetStatusSchema.optional(),
  active: z.boolean().optional(),
});
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;
