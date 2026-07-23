import type { Request } from 'express';

/** `x-request-id` correlates a mutation to its `audit_event` row (PR-API-12). Shared across domain controllers. */
export function requestMeta(req: Request): { sourceIp?: string; requestId?: string } {
  const requestId = req.headers['x-request-id'];
  return {
    sourceIp: req.ip,
    requestId: Array.isArray(requestId) ? requestId[0] : requestId,
  };
}
