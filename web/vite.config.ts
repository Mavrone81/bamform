import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal Vite config for the slice-1 stub. The real PWA config (service
// worker, manifest, offline caching per PR-059..069) lands in slice 10.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
});
