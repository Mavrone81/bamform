import { randomBytes } from 'node:crypto';

/**
 * Slice 13a / Samuel's decision (B-09 — "the real machine codes ... must be
 * supplied by the client before go-live", `docs/TEMPLATE_LOAD_PLAN.md`):
 * until then, an admin adding an asset without typing a `code` gets one
 * auto-generated here and flagged PROVISIONAL/"RED" (`Asset.codeProvisional`)
 * so the UI can visibly distinguish "the system made this up" from "an admin
 * confirmed this identifies a real machine". The admin later types the real
 * code over it via `PATCH /assets/{id}`, which clears the flag.
 *
 * Format is deliberately NOT one of the real per-document code shapes
 * (`AW01`, `IMOS 01`, ...) — a provisional code must never be mistakable for
 * a confirmed one. `PROV-` + 8 hex chars keeps it inside `assetCodeSchema`'s
 * 1-50 char bound with room to spare.
 */
export function generateProvisionalAssetCode(): string {
  return `PROV-${randomBytes(4).toString('hex').toUpperCase()}`;
}
