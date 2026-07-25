import { test as base, expect, type Page } from '@playwright/test';
import { FakeServer, type SeedJob } from './fake-server';

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

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('tech@bevorasg.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
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
