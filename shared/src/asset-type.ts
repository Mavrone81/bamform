import { z } from 'zod';

/**
 * DBD §6.7 `asset_type` — PR-019. One `form_template` per type (1:1, see
 * `asset_type_form_template_id_key` in
 * `20260724010000_asset_type_form_template_unique_and_audit_chain_lock`).
 */

export const assetTypeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  formTemplateId: z.string().uuid(),
  approvalRouteId: z.string().uuid(),
  leadTimeDays: z.number().int(),
  active: z.boolean(),
});
export type AssetType = z.infer<typeof assetTypeSchema>;

export const assetTypeCreateSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  formTemplateId: z.string().uuid(),
  approvalRouteId: z.string().uuid(),
  leadTimeDays: z.number().int().positive().optional(),
});
export type AssetTypeCreate = z.infer<typeof assetTypeCreateSchema>;

/**
 * Slice 13-TL: `GET /approval-routes` — read-only reference data (seeded by
 * migration, PR-DBD-09). Exists so `POST /asset-types`' required
 * `approvalRouteId` can be resolved over HTTP (the template-load tooling
 * and the admin UI both need it; previously there was no HTTP source).
 */
export const approvalRouteSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type ApprovalRoute = z.infer<typeof approvalRouteSchema>;

export const assetTypeUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  leadTimeDays: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});
export type AssetTypeUpdate = z.infer<typeof assetTypeUpdateSchema>;
