import { z } from 'zod';

/**
 * DBD §6.1 `area` — physical/organisational area used to scope visibility
 * (PR-040, ADR-005: scoping applied in the repository layer, not RLS).
 */

export const areaSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  parentId: z.string().uuid().nullable(),
  active: z.boolean(),
});
export type Area = z.infer<typeof areaSchema>;

export const areaCreateSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1),
  parentId: z.string().uuid().optional(),
});
export type AreaCreate = z.infer<typeof areaCreateSchema>;

export const areaUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  parentId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
});
export type AreaUpdate = z.infer<typeof areaUpdateSchema>;
