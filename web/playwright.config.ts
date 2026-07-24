import { defineConfig, devices } from '@playwright/test';

/**
 * CI already composes the full stack before invoking any of these projects
 * (.github/workflows/ci.yml jobs 7-9: `docker compose -f
 * docker-compose.ci.yml up -d --wait`, which serves the real production
 * build of this app through nginx at 127.0.0.1:8080 — see web/Dockerfile).
 * These tests intercept every `/api/v1/**` call at the browser network
 * boundary (e2e/support/fake-server.ts), so they do not depend on whichever
 * server actually answers that origin — real backend or none at all — only
 * on the ORIGIN being reachable. That is true in CI without any change
 * here. Locally, `webServer` builds and previews the app on its own.
 */
const isCI = Boolean(process.env.CI);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? (isCI ? 'http://127.0.0.1:8080' : 'http://localhost:4173');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    viewport: { width: 375, height: 812 }, // mobile-first baseline (E-RSP-01/02)
  },
  webServer: isCI
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --port 4173 --strictPort',
        port: 4173,
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'offline',
      testDir: './e2e/offline',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'a11y',
      testDir: './e2e/a11y',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'e2e',
      testDir: './e2e/journeys',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
