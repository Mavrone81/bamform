import { z } from 'zod';

/**
 * `GET /audit-events/chain-status` response — PR-097/PR-099, SECURITY_ARCHITECTURE.md
 * §4.2 P2 ("Identify the first break sequence from `GET /audit-events/chain-status`").
 * Mirrors `api/openapi.yaml`'s `AuditChainStatus` schema exactly (ALL FOUR
 * keys required; `firstBreakSequence` is `nullable` — the key is ALWAYS
 * present, its value is `null` unless `intact` is false, in which case it's
 * the first broken sequence number). Deliberately `.nullable()`, NOT
 * `.optional()`: the controller always emits the key, so the contract says
 * so too — the slice-7 review caught a contract-vs-code mismatch once; this
 * schema is the single source both the controller response type and the
 * openapi component are checked against.
 */
export const auditChainStatusSchema = z.object({
  intact: z.boolean(),
  checkedAt: z.string(),
  eventCount: z.number().int().nonnegative(),
  firstBreakSequence: z.number().int().nullable(),
});
export type AuditChainStatus = z.infer<typeof auditChainStatusSchema>;
