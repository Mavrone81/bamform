import { test, expect } from '@playwright/test';
import { FakeServer, E2E_USERS } from '../support/fake-server';
import { signInAs } from '../support/fixtures';

/**
 * Slice 18-WORKFLOW §2 — raising work OFF-PLAN through the real UI.
 *
 * The owner's process, step 1: the team works from "the maintenance plan OR
 * AD-HOC REQUEST". Until this slice the second half had no screen, no
 * endpoint and no way to be recorded at all. This drives the whole path a
 * planner actually walks: Menu → Raise a job → pick the machine → give the
 * mandatory reason → the job exists and opens.
 */
test.describe('E-15: raise an ad-hoc job', () => {
  test('a team leader raises off-plan work, and the mandatory reason gates it', async ({
    page,
  }) => {
    const server = new FakeServer();
    const wireBonder = server.seedAsset({
      code: 'WB-77',
      assetTypeId: 'at-1',
      description: 'Wire bonder, bay 3',
    });
    await server.install(page);
    await signInAs(page, E2E_USERS.teamLeader.email);

    // The entry is offered from the Menu for a permitted role.
    await page.goto('/menu');
    await page.getByRole('button', { name: 'Raise a job' }).click();
    await expect(page.getByRole('heading', { name: 'Raise a job' })).toBeVisible();

    // Nothing can be raised until a machine AND a real reason are given —
    // the same >= 10-character rule the database enforces.
    const raise = page.getByRole('button', { name: 'Raise this job' });
    await expect(raise).toBeDisabled();
    await page.getByLabel('Machine', { exact: true }).selectOption(wireBonder.id);
    await expect(raise).toBeDisabled();
    await page.getByLabel('Why is this being raised off-plan?').fill('broke');
    await expect(raise).toBeDisabled();

    await page
      .getByLabel('Why is this being raised off-plan?')
      .fill('bearing seized on the night shift, unplanned service');
    await expect(raise).toBeEnabled();
    await raise.click();

    // Lands on the new job's capture screen — it is a real job, with the
    // machine's frozen checklist, reachable exactly like a planned one.
    await expect(page.getByRole('heading', { name: /^PM-2026-9/ })).toBeVisible();
    await expect(page.getByText('WB-77')).toBeVisible();
  });

  test('a maintainer is not offered the entry (presentation), and the server refuses the action (enforcement)', async ({
    page,
  }) => {
    const server = new FakeServer();
    server.seedAsset({ code: 'WB-78', assetTypeId: 'at-1' });
    await server.install(page);
    await signInAs(page, E2E_USERS.technician.email);

    await page.goto('/menu');
    await expect(page.getByRole('button', { name: 'Raise a job' })).toHaveCount(0);

    // Non-negotiable #6: the URL stays reachable and the SERVER refuses —
    // the screen surfaces that refusal rather than pretending it succeeded.
    await page.goto('/jobs/raise');
    await expect(page.getByRole('heading', { name: 'Raise a job' })).toBeVisible();
    await page.getByLabel('Machine', { exact: true }).selectOption({ index: 1 });
    await page
      .getByLabel('Why is this being raised off-plan?')
      .fill('trying to raise work I am not permitted to raise');
    await page.getByRole('button', { name: 'Raise this job' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Raise a job' })).toBeVisible();
  });
});
