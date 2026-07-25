/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Same-origin relative path (see .env.example). Never an absolute
   * cross-origin URL — CSP `connect-src 'self'` depends on that. */
  readonly VITE_API_BASE_URL: string;
  readonly VITE_OFFLINE_HISTORY_DAYS: string;
  /** Build hash injected by web/Dockerfile — used to version the service
   * worker's cache name (PR-068). */
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
