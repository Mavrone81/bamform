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
 * `areaId` (13-UI-B review B-1): NULLABLE — an explicit `null` clears the
 * area assignment (a machine placed in the wrong scoped area must be
 * movable OUT, since area membership now decides who can see it), while
 * omission still means "no change".
 */
export const assetUpdateSchema = z.object({
  code: assetCodeSchema.optional(),
  description: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  areaId: z.string().uuid().nullable().optional(),
  locationDetail: z.string().optional(),
  status: assetStatusSchema.optional(),
  active: z.boolean().optional(),
});
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

// ------------------------------------------------- slice 27 asset_document

/**
 * `GET /assets/{assetId}/documents` — the machine's tagged PM documents.
 *
 * `title`, `resolvedTitle` and `titleHasFillableRun` are DERIVED per response
 * from the template's current title (see `resolveTemplateTitle`), never stored.
 * A revision that changes the title therefore stays correct.
 *
 * This comment previously added "and slice 23-PDFA freezes the rendered result
 * at archive so a signed record keeps the title it was signed under". That is
 * false — slice 23-PDFA is an unbuilt plan and a record's PDF is re-rendered
 * live from current data on every request. See `resolveTemplateTitle`'s note
 * in `template-title.ts` for what actually protects an archived record's
 * title, and what it does not cover.
 */
export const assetDocumentSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  formTemplateId: z.string().uuid(),
  documentNumber: z.string(),
  /** The template's stored title, blank and all. */
  title: z.string(),
  /** The title with `machineNumber` substituted into its blank, if there is one. */
  resolvedTitle: z.string(),
  /**
   * Whether the title carries a fillable run of underscores. This is what the
   * admin screen keys the form-number field off: an admin is never offered a
   * box that does nothing, so they can never believe they have labelled a form
   * when they have not. 8 of the 12 real templates carry one.
   */
  titleHasFillableRun: z.boolean(),
  machineNumber: z.string().nullable(),
  active: z.boolean(),
});
export type AssetDocument = z.infer<typeof assetDocumentSchema>;

/** `POST /assets/{assetId}/documents` — ADMIN only. */
export const assetDocumentCreateSchema = z.object({
  formTemplateId: z.string().uuid(),
  /**
   * Never required and never a validation error, whatever the title looks like
   * (owner, 2026-07-29: "Is ok some forms are already pre updated just allow
   * user to choose"). Supplied for a title with no blank, it is simply stored
   * and has nothing to substitute into.
   */
  machineNumber: z.string().trim().min(1).max(50).nullable().optional(),
});
export type AssetDocumentCreate = z.infer<typeof assetDocumentCreateSchema>;

/**
 * `PATCH /asset-documents/{id}` — ADMIN only. There is no DELETE: INV-16
 * forbids it on record tables, and a document that has generated jobs must stay
 * resolvable. `active: false` stops future job generation and leaves history
 * intact.
 */
export const assetDocumentUpdateSchema = z.object({
  machineNumber: z.string().trim().min(1).max(50).nullable().optional(),
  active: z.boolean().optional(),
});
export type AssetDocumentUpdate = z.infer<typeof assetDocumentUpdateSchema>;
