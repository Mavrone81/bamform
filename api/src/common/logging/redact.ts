/**
 * S-15 (threat I-3, TEST_PLAN §9): "Login with a known password — password
 * absent from all log output." Deep-redacts anything that looks like a
 * secret before it reaches a log sink, whether the caller logs a structured
 * object ({ password: '...' }) or a free-text string ("password=...").
 *
 * Used by `RedactingLogger` (./redacting-logger.ts), which is wired as the
 * app-wide Nest logger in `main.ts` — every `Logger.log/error/warn/debug/
 * verbose` call in the application passes through this, not just call
 * sites that remember to redact manually.
 */

const REDACTED = '[REDACTED]';

/**
 * Key names (case-insensitive, matched as a substring) treated as secret.
 *
 * Slice 13-MFA adds `recoveryCode`/`backupCode`/`otpauth`/`totp`. The
 * pre-existing `secret` and `token` alternatives already cover
 * `mfaSecretCt`, `mfaSecret` and `challengeToken`, but a recovery code and an
 * `otpauth://` URI (which embeds the shared secret in its query string) match
 * nothing in the original set. A bare `code` is deliberately NOT listed —
 * `roleCode`, `assetCode`, `areaCode`, `codeBidx` and the machine codes are
 * all non-secret and redacting them would make failure logs unreadable for
 * no security gain.
 *
 * That exclusion left a residue the review caught (M-5): two MFA DTO fields
 * were themselves called `code` and held a live TOTP code and a live recovery
 * code. The fix was to rename the FIELDS — they are now `totpCode` and
 * `recoveryCode` (`shared/src/mfa.ts`), both of which the pattern below
 * already matches — rather than to widen the pattern and blind every failure
 * log to `roleCode`. Naming a field for what it holds is what makes brief
 * §8's "never log a TOTP code, a recovery code" structural instead of
 * accidental.
 */
const SENSITIVE_KEY_PATTERN =
  /pass(?:word)?|secret|token|api[-_]?key|authorization|cookie|dek\b|private[-_]?key|signing[-_]?key|hmac|blind[-_]?index[-_]?key|client[-_]?secret|recovery[-_]?code|backup[-_]?code|otpauth|totp/i;

/**
 * Matches `key: value` / `key=value` / `"key": "value"` in free-text where
 * `key` looks like a secret field name, and redacts only the value —
 * `("?\bKEY_PATTERN\b[a-zA-Z_]*"?\s*[:=]\s*)(VALUE)` — keeping the key name
 * and surrounding text intact so log lines stay readable.
 */
const INLINE_SECRET_PATTERN = new RegExp(
  `("?\\b[a-zA-Z_]*(?:${SENSITIVE_KEY_PATTERN.source})[a-zA-Z_]*"?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,}]+)`,
  'gi',
);

/** Redacts secret-looking `key=value` / `key: "value"` fragments inside a free-text string. */
export function redactString(input: string): string {
  return input.replace(
    INLINE_SECRET_PATTERN,
    (_match, keyPart: string) => `${keyPart}"${REDACTED}"`,
  );
}

function isRedactableObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !Buffer.isBuffer(value)
  );
}

/**
 * Deep-redacts a value for logging: object/array keys whose name matches
 * `SENSITIVE_KEY_PATTERN` have their value replaced wholesale; strings
 * (including nested ones) are scanned with `redactString`. Safe against
 * circular references.
 */
export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => redactSecrets(item, seen));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack };
  }
  if (isRedactableObject(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(val, seen);
    }
    return out;
  }
  return value;
}
