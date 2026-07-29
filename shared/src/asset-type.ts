import { z } from 'zod';

/**
 * DBD §6.7 `asset_type` — PR-019.
 *
 * Slice 27-ASSETDOC removed `formTemplateId`. It was UNIQUE, which made the
 * machine->form relation one-to-one in BOTH directions: a machine family could
 * hold one document, and a document could serve one machine family. The
 * owner's 2026 schedule workbook contradicts both (TE7 carries a monthly
 * pH-meter check AND its monthly PM; CM02 and CM03 share CE 95 030 00 01).
 *
 * An asset type is now purely the machine-family grouping: the approval route
 * and the lead time, both genuinely family-wide properties. The route from a
 * machine to a form is `asset_document` — see `assetDocumentSchema`.
 */

export const assetTypeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  approvalRouteId: z.string().uuid(),
  leadTimeDays: z.number().int(),
  active: z.boolean(),
});
export type AssetType = z.infer<typeof assetTypeSchema>;

export const assetTypeCreateSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1),
  description: z.string().optional(),
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
