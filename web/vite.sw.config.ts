import { defineConfig } from 'vite';
import path from 'node:path';
// @ts-expect-error -- plain .mjs build helper, shared with e2e/support/deploy-server.ts
import { fingerprintAssets, readEmittedAssets } from './scripts/asset-fingerprint.mjs';

// Separate, minimal build for the service worker (src/sw.ts). It must be a
// single classic script with no import statements (broadest service-worker
// registration compatibility — no `{ type: 'module' }` requirement), so it
// is built independently from the main app bundle rather than emitted as
// one of its chunks.
//
// Slice 22-SELFUPDATE (review finding S-1): the worker's version is no longer
// `VITE_APP_VERSION` alone. Production pins that variable to the constant
// `local`, which made `sw.js` BYTE-IDENTICAL across every real deploy and
// rendered `registration.update()` — the entire basis of the self-update
// mechanism — permanently inert on the only deployment that matters.
// `__BAMFORM_BUILD_ID__` is derived from the asset filenames the app build
// just emitted, which are content hashes: it changes if and only if the app
// changed, whatever the environment says. See scripts/asset-fingerprint.mjs.
export default defineConfig(() => {
  const assets = readEmittedAssets(path.resolve(__dirname, 'dist/assets')) as string[] | null;
  const envVersion = process.env.VITE_APP_VERSION ?? 'dev';
  // No assets to read means the worker is being built on its own against an
  // empty dist. Fall back to the env version rather than inventing a
  // fingerprint — a value that changed on every build would put every client
  // into a reload loop, which is worse than the staleness it would be fixing.
  const buildId = assets ? `${envVersion}-${fingerprintAssets(assets) as string}` : envVersion;

  return {
    define: {
      __BAMFORM_BUILD_ID__: JSON.stringify(buildId),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry: 'src/sw.ts',
        formats: ['iife' as const],
        fileName: () => 'sw.js',
        name: 'BamFormServiceWorker',
      },
    },
  };
});
