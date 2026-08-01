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

/** Draws a deliberately long, multi-segment stroke across the on-page
 * signature pad using real mouse-driven pointer events (Chromium dispatches
 * genuine pointerdown/pointermove/pointerup for mouse input, exercising the
 * SAME code path a stylus would) — a real signature captured by the real
 * canvas, not a stub.
 *
 * `scrollIntoViewIfNeeded()` runs BEFORE `boundingBox()` is read: at narrow
 * viewports (375px) the pad can sit below the initial fold once the review
 * page's real content (checklist text, approval-progress copy, etc.) wraps
 * across more lines than it does at wider viewports — the coordinates
 * `page.mouse` dispatches are relative to the CURRENT scroll position, so
 * reading `boundingBox()` without first scrolling the element into view can
 * hand back a y-coordinate below the visible viewport. Mouse events
 * dispatched there never reach the canvas, no stroke registers, `hasInk`
 * never flips true, and clicking "Done" hits the client-side blank-signature
 * rejection instead of calling `verifyJob` — so the step-up flow this test
 * depends on never starts. Scrolling first (a no-op when already in view)
 * and re-reading the box afterward makes the draw land on the real canvas
 * at every viewport, deterministically. */
export async function drawSignature(page: Page): Promise<void> {
  const canvas = page.locator('.signature-pad-canvas');
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('signature pad canvas has no bounding box');
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.2, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.75, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.up();
}

/**
 * Slice 18-WORKFLOW §1 — the technician's submit is now a two-step act:
 * "Sign and submit" opens the pad, they draw, "Done" sends the record with
 * the PNG attached. Every journey/offline spec that submits goes through
 * this helper so the flow lives in ONE place, and so a change to it fails
 * loudly rather than being re-derived nine times.
 *
 * It uses the SAME real mouse-driven pointer events `drawSignature` uses —
 * no stub, no injected data-URL: the canvas really is drawn on.
 */
export async function signAndSubmit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign and submit' }).click();
  const pad = page.getByTestId('performer-signature');
  await expect(pad).toBeVisible();
  await drawSignature(page);
  // Scoped to the pad: the capture screen's per-item status controls also
  // offer a "Done" button, so an unscoped lookup is a strict-mode violation.
  await pad.getByRole('button', { name: 'Done' }).click();
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
