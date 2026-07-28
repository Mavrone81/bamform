/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Same-origin relative path (see .env.example). Never an absolute
   * cross-origin URL — CSP `connect-src 'self'` depends on that. */
  readonly VITE_API_BASE_URL: string;
  readonly VITE_OFFLINE_HISTORY_DAYS: string;
  /** Label injected by web/Dockerfile. Slice 22 (review S-1): this is NO
   * LONGER what versions the service worker — production pins it to the
   * constant `local`, which made every deploy's `sw.js` byte-identical. See
   * `__BAMFORM_BUILD_ID__` below. */
  readonly VITE_APP_VERSION: string;
}

/**
 * The service worker's real version: `VITE_APP_VERSION` plus a fingerprint of
 * the content-hashed asset filenames the app build emitted. Injected by
 * `vite.sw.config.ts`; changes if and only if the built app changed, which no
 * environment variable can pin. Only `src/sw.ts` reads it.
 */
declare const __BAMFORM_BUILD_ID__: string;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
