import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';

/**
 * A short, stable fingerprint of a built app's emitted asset filenames.
 *
 * ## Why this exists (slice 22-SELFUPDATE, review finding S-1)
 *
 * The service worker's only build-varying content used to be its cache name,
 * `bamform-shell-${VITE_APP_VERSION}` — and production pins that to a
 * constant. `docker-compose.yml` maps `VITE_APP_VERSION: ${IMAGE_TAG:-local}`,
 * `.env.example` sets `IMAGE_TAG=local`, and `auto-deploy-bamform.sh` sources
 * that `.env` with `set -a` and never overrides it from the commit it just
 * checked out. CI passes `${GITHUB_SHA::7}`, but the CI job only proves images
 * build — the droplet builds its own.
 *
 * The measured consequence: two builds from genuinely different source, under
 * production's exact environment, produced a BYTE-IDENTICAL `sw.js`
 * (`fe6d1732…` both times). `registration.update()` re-fetches it,
 * byte-compares, correctly finds no change, and the whole self-update
 * mechanism reports "up to date" on every trigger, forever. Every test
 * passed and the owner's tablet stayed stale.
 *
 * Deriving the version from the BUILD OUTPUT instead of from the environment
 * makes that class of failure impossible: Vite names every asset by a hash of
 * its content, so if the app changed at all, this string changed, whatever
 * any env var says. `VITE_APP_VERSION` is still mixed in when it is
 * meaningful (CI, or a deploy that sets `IMAGE_TAG`) — it is now a useful
 * label rather than the load-bearing mechanism.
 *
 * Shared, not duplicated: `vite.sw.config.ts` uses it to stamp the worker,
 * and `e2e/support/deploy-server.ts` uses it to derive its second generation
 * the same way the real build would. The E2E harness previously manufactured
 * that difference by string substitution, which is exactly why it could not
 * fail for the reason production was broken (review S-5).
 */
export function fingerprintAssets(assetFileNames) {
  const canonical = [...assetFileNames].sort().join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * Reads the asset filenames the main build just emitted. The service worker
 * is built second (`npm run build` runs the app build, then this one, with
 * `emptyOutDir: false`), so `dist/assets` is already populated by the time
 * this is called.
 *
 * Returns null when there is nothing to read — building the worker on its own
 * against an empty `dist`. The caller degrades to the env-var-only version
 * rather than inventing a fingerprint that would differ on every build and
 * put clients into a reload loop.
 */
export function readEmittedAssets(assetsDir) {
  try {
    const names = readdirSync(assetsDir);
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}
