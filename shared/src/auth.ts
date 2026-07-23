import { z } from 'zod';

/**
 * Auth request/response DTOs — mirrors `api/openapi.yaml` `/auth/*` and
 * `/.well-known/jwks.json` schemas exactly (the YAML is authoritative;
 * BUILD_HANDOFF §1 read order). Shared with `web` so client-side validation
 * is the same rule, not a reimplementation (ADR-002).
 */

// ---------------------------------------------------------------- POST /auth/login

export const loginRequestSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(12),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ------------------------------------------------------------- POST /auth/step-up

export const stepUpRequestSchema = z.object({
  password: z.string().min(1),
});
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>;

export const stepUpResponseSchema = z.object({
  stepUpValidUntil: z.string(),
});
export type StepUpResponse = z.infer<typeof stepUpResponseSchema>;

// ---------------------------------------------------------------- CurrentUser

export const activeDelegationSchema = z.object({
  delegatorId: z.string().uuid(),
  delegatorName: z.string(),
  validTo: z.string(),
});

export const currentUserSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  email: z.string().email().optional(),
  roles: z.array(z.string()),
  areaScope: z.array(z.string().uuid()).optional(),
  activeDelegations: z.array(activeDelegationSchema).optional(),
  stepUpValidUntil: z.string().nullable().optional(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

// ------------------------------------------------- POST /auth/login, /auth/refresh

export const authResultSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: currentUserSchema,
});
export type AuthResult = z.infer<typeof authResultSchema>;

// ---------------------------------------------------- GET /.well-known/jwks.json

export const jwkSchema = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    kid: z.string(),
    x: z.string(),
  })
  .catchall(z.unknown());

export const jwksResponseSchema = z.object({
  keys: z.array(jwkSchema),
});
export type JwksResponse = z.infer<typeof jwksResponseSchema>;
