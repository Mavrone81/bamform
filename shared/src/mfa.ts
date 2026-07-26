import { z } from 'zod';
import { authResultSchema } from './auth';

/**
 * Slice 13-MFA — TOTP multi-factor auth + password self-service DTOs.
 * Mirrors `api/openapi.yaml`'s `/auth/mfa/*`, `/auth/password` and
 * `/users/{userId}/mfa-reset` schemas EXACTLY, required-vs-optional included
 * (ADR-002: one rule, validated the same way client and server).
 *
 * ⚠️ Nothing in this file is ever logged. `secret`, `otpauthUri`,
 * `recoveryCodes`, `totpCode`, `recoveryCode` and both password fields are
 * credential material; `RedactingLogger`
 * (`common/logging/redacting-logger.ts`) covers the key names, and job 6's
 * `test:log-redaction` is the gate.
 *
 * The two credential fields are named `totpCode` and `recoveryCode`, not
 * `code` (review finding M-5). A bare `code` cannot be added to the redaction
 * pattern — `roleCode`, `assetCode`, `areaCode` and the machine codes are all
 * non-secret and redacting them would make failure logs unreadable — so
 * naming the field for what it holds is what actually makes brief §8's "never
 * log a recovery code, a TOTP code" true by construction rather than by
 * nobody happening to log a request body.
 */

/** A 6-digit TOTP code, or the same code as the authenticator app groups it ("123 456"). */
const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{3}[\s-]?\d{3}$/, 'Enter the 6-digit code from your authenticator app');

/**
 * A recovery code as printed at enrolment (`ABCD-EFGH-...`, 8 groups of 4),
 * accepted case-insensitively and with any spacing — the server normalises
 * before hashing (`normaliseRecoveryCode`). Bounded so an oversized body
 * cannot reach the HMAC.
 */
const recoveryCodeSchema = z.string().trim().min(32).max(64);

const challengeTokenSchema = z.string().min(1);

// ------------------------------------------------- POST /auth/login (MFA branch)

/**
 * The alternative 200 body of `POST /auth/login` when — and only when —
 * `MFA_ENABLED=true` AND the account holds a role in `MFA_REQUIRED_ROLES`.
 * No access token and no refresh cookie are issued alongside it.
 *
 * ⚠️ `challengeToken` is a TOKEN. Non-negotiable #10 applies to it exactly as
 * it applies to the access token: slice 13-UI must hold it in memory only and
 * must never put it in `localStorage`/`sessionStorage`.
 */
export const mfaChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  mfaEnrolled: z.boolean(),
  challengeToken: challengeTokenSchema,
  expiresIn: z.number().int().positive(),
});
export type MfaChallengeResponse = z.infer<typeof mfaChallengeResponseSchema>;

/** `POST /auth/login` returns one or the other. With `MFA_ENABLED=false` it is always `AuthResult`. */
export const loginResponseSchema = z.union([authResultSchema, mfaChallengeResponseSchema]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export function isMfaChallengeResponse(value: LoginResponse): value is MfaChallengeResponse {
  return (value as MfaChallengeResponse).mfaRequired === true;
}

// -------------------------------------------------------- POST /auth/mfa/enrol

/**
 * `challengeToken` is present when enrolling mid-login (the user was
 * challenged and is not yet enrolled); absent when an already-signed-in user
 * enrols voluntarily with a normal `Authorization: Bearer` access token.
 */
export const mfaEnrolRequestSchema = z.object({
  challengeToken: challengeTokenSchema.optional(),
});
export type MfaEnrolRequest = z.infer<typeof mfaEnrolRequestSchema>;

/**
 * `secret` is the base32 shared secret for manual entry; `otpauthUri` is the
 * same secret in the URI form a QR code encodes. The QR IMAGE is rendered
 * client-side in slice 13-UI — the api takes on no QR dependency (brief §5).
 */
export const mfaEnrolResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type MfaEnrolResponse = z.infer<typeof mfaEnrolResponseSchema>;

// ------------------------------------------------ POST /auth/mfa/enrol/confirm

export const mfaEnrolConfirmRequestSchema = z.object({
  totpCode: totpCodeSchema,
  challengeToken: challengeTokenSchema.optional(),
});
export type MfaEnrolConfirmRequest = z.infer<typeof mfaEnrolConfirmRequestSchema>;

/**
 * `recoveryCodes` is returned **once**, here, and is never retrievable again
 * (brief §5). `auth` is non-null only when this call completed a login
 * challenge (§4.4) — for a voluntary enrolment by an already-signed-in user
 * it is `null`, because that user already holds a session.
 */
export const mfaEnrolConfirmResponseSchema = z.object({
  recoveryCodes: z.array(z.string()),
  auth: authResultSchema.nullable(),
});
export type MfaEnrolConfirmResponse = z.infer<typeof mfaEnrolConfirmResponseSchema>;

// ------------------------------------------------------- POST /auth/mfa/verify

export const mfaVerifyRequestSchema = z.object({
  challengeToken: challengeTokenSchema,
  totpCode: totpCodeSchema,
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

// ----------------------------------------------------- POST /auth/mfa/recovery

export const mfaRecoveryRequestSchema = z.object({
  challengeToken: challengeTokenSchema,
  recoveryCode: recoveryCodeSchema,
});
export type MfaRecoveryRequest = z.infer<typeof mfaRecoveryRequestSchema>;

// --------------------------------------------------------- POST /auth/password

/**
 * Brief §7. `newPassword` uses the same 12-character minimum as
 * `loginRequestSchema` and `userCreateSchema` — one policy, three call sites,
 * not three policies.
 */
export const passwordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;
