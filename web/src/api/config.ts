/**
 * `VITE_API_BASE_URL` per .env.example — a same-origin RELATIVE path
 * (CSP `connect-src 'self'` depends on that), documented default `/api/v1`.
 *
 * Falls back to that documented default rather than trusting the env
 * injection to always be present: `web/Dockerfile` only forwards
 * `VITE_APP_VERSION` as a build ARG today, and `.env` files are (correctly)
 * git-ignored repo-wide, so a fresh checkout building without an explicit
 * override would otherwise silently produce `/undefined/sync/bootstrap` —
 * exactly the failure this default exists to prevent. Genuinely different
 * deployments that need a different base still override it via the real
 * env var; this only guards the "nobody set it" case.
 */
export const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';
