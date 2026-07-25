import { defineConfig } from 'vite';

// Separate, minimal build for the service worker (src/sw.ts). It must be a
// single classic script with no import statements (broadest service-worker
// registration compatibility — no `{ type: 'module' }` requirement), so it
// is built independently from the main app bundle rather than emitted as
// one of its chunks. `import.meta.env.VITE_APP_VERSION` is still replaced
// here exactly as it is in the main build (Vite's env replacement is not
// specific to vite.config.ts), which is what gives the worker a
// build-hash-versioned cache name (PR-068).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/sw.ts',
      formats: ['iife'],
      fileName: () => 'sw.js',
      name: 'BamFormServiceWorker',
    },
  },
});
