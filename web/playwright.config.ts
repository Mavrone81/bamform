import { defineConfig, devices } from '@playwright/test';

/**
 * CI composes only the `bamform-web` service before invoking any of these
 * projects (.github/workflows/ci.yml jobs 7-9: `docker compose -f
 * docker-compose.ci.yml up -d --wait bamform-web`), which serves the real
 * production build of this app through nginx at 127.0.0.1:8080 — see
 * web/Dockerfile. These tests intercept every `/api/v1/**` call at the
 * browser network boundary (e2e/support/fake-server.ts), so they do not
 * depend on whichever server actually answers that origin — real backend or
 * none at all — only on the ORIGIN being reachable. That is why CI does not
 * need to bring up bamform-api/postgres/redis/minio at all: nothing under
 * test ever reaches them, and standing them up only adds failure surface
 * (e.g. the api-track's MinIO image) with zero test value. Locally,
 * `webServer` builds and previews the app on its own.
 */
const isCI = Boolean(process.env.CI);
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ?? (isCI ? 'http://127.0.0.1:8080' : 'http://localhost:4173');

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
      // ci.yml job 8 runs this project once per matrix entry (375/768/1280)
      // via VIEWPORT_WIDTH. There is no ./e2e/journeys content yet (E-01..
      // E-14 are slice 11/12/13 work — verifier queue, PDF render, admin UI
      // none of which exist on main); this project intentionally has zero
      // specs to collect today. Wired correctly now so the matrix actually
      // does something the moment those specs land, instead of needing a
      // second CI change alongside the first journey spec.
      name: 'e2e',
      testDir: './e2e/journeys',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: Number(process.env.VIEWPORT_WIDTH ?? 1280), height: 900 },
      },
    },
    {
      // Slice 14-DESIGN §5: captures the owner-review screenshot set into
      // web/design-screenshots/ at 375/768/1280. Never invoked by CI (jobs
      // run the offline/e2e/a11y projects by name); run it locally with
      // `npx playwright test --project=design` after visual changes.
      name: 'design',
      testDir: './e2e/design',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
