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
