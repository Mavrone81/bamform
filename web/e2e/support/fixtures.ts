import { test as base, expect, type Page } from '@playwright/test';
import { FakeServer, E2E_USERS, E2E_PASSWORD, type SeedJob } from './fake-server';

export const DEFAULT_JOB: SeedJob = {
  id: 'job-1',
  jobNumber: 'PM-2026-000431',
  assetCode: 'AW03',
  frequency: 'M3',
  dueOn: '2026-08-01',
  items: [
    { id: 'item-1', itemNo: 1, instruction: 'Check heater block temperature' },
    { id: 'item-2', itemNo: 2, instruction: 'Inspect wire bond capillary' },
  ],
};

/** Signs in as an arbitrary user (default: the technician every existing
 * offline/a11y spec uses) — exported so the verifier-queue/delegation
 * journeys (E-02/03/04), which need several distinct actors, can reuse it
 * instead of duplicating the sign-in flow per actor. */
export async function signInAs(
  page: Page,
  email: string = E2E_USERS.technician.email,
  password: string = E2E_PASSWORD,
): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
}

async function signIn(page: Page): Promise<void> {
  await signInAs(page);
}

interface Fixtures {
  server: FakeServer;
  signedInPage: Page;
}

export const test = base.extend<Fixtures>({
  server: async ({ page }, use) => {
    const server = new FakeServer();
    server.seedJob(DEFAULT_JOB);
    await server.install(page);
    await use(server);
  },
  signedInPage: async ({ page, server }, use) => {
    void server; // ensures the server fixture (and its route installation) runs first
    await signIn(page);
    await use(page);
  },
});

export { expect };
