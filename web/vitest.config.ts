import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Unit tests for the PWA. The offline/outbox/sync-engine machinery is the
// highest-risk code in the project (RK-01) and carries a 95%/90% line/branch
// coverage floor (TEST_PLAN §4) enforced per-directory below, tighter than
// the repo-wide UI floor (70%/60%, met more meaningfully by E2E per §4).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/offline/**', 'src/api/**', 'src/auth/**', 'src/lib/**'],
      exclude: ['src/api/generated/**', 'src/api/mock-transport.ts'],
      thresholds: {
        'src/offline/**': { lines: 95, branches: 90 },
        'src/lib/**': { lines: 95, branches: 90 },
        'src/auth/**': { lines: 95, branches: 90 },
      },
    },
  },
});
