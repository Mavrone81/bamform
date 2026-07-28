import { test, expect } from '../support/fixtures';
import { E2E_PASSWORD, E2E_USERS } from '../support/fake-server';
import { DeployServer } from '../support/deploy-server';
import type { Page } from '@playwright/test';

/**
 * O-12, finally driven end to end (slice 22-SELFUPDATE §5).
 *
 * The old O-12 case was a `test.fixme` — skipped as flaky — and that
 * deferral is the direct cause of the owner being stranded on a phone
 * running pre-signature JavaScript against a post-signature API, twice, in
 * one sitting. What follows is the test that was owed: build A is served,
 * build B is deployed underneath a live client, and the client is required
 * to end up on build B **without the test touching it** — no `reload()`, no
 * cache clearing, no reinstall.
 *
 * "On build B" is asserted from `window.__E2E_BUILD_JS`, which only build
 * B's bundle sets. Nothing here infers an update from a request being made;
 * it is only ever the new JavaScript actually executing that passes.
 *
 * The triggers used are real browser events produced by real state changes
 * (a network reconnect; a rejected API call), never a synthetic
 * `dispatchEvent`. See `update.ts` for why those are the triggers that
 * matter and `deploy-server.ts` for what makes generation B a genuine
 * deploy.
 */

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel('Email').fill(E2E_USERS.technician.email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your jobs' })).toBeVisible();
}

/**
 * Which generation's JavaScript is currently executing in the page.
 *
 * The `catch` is the difference between this spec and the one that was
 * abandoned as flaky. A successful self-update IS a navigation, so any probe
 * polling for the result will sooner or later evaluate into a context that
 * is being torn down and get "Execution context was destroyed" — which the
 * previous attempt saw as flakiness and which is in fact the mechanism
 * working. Reporting "unknown" lets `expect.poll` ask again a moment later,
 * on the new document. Nothing is swallowed that could make a stale client
 * pass: the poll's only exit is observing build B's JavaScript running.
 */
async function runningBuild(page: Page): Promise<string> {
  try {
    return await page.evaluate(
      () =>
        ((window as unknown as { __E2E_BUILD_JS?: string }).__E2E_BUILD_JS ??
          document.querySelector('meta[name=e2e-build]')?.getAttribute('content') ??
          '?') as string,
    );
  } catch {
    return 'mid-navigation';
  }
}

/** The outbox, read straight out of IndexedDB rather than out of the UI —
 * the point is the durable rows, not a label. */
function outboxRows(page: Page): Promise<Array<{ id: string; status: string }>> {
  return page.evaluate(
    () =>
      new Promise<Array<{ id: string; status: string }>>((resolve, reject) => {
        const open = indexedDB.open('bamform-offline');
        open.onerror = () => reject(new Error('cannot open bamform-offline'));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('outbox')) return resolve([]);
          const all = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          all.onsuccess = () =>
            resolve(
              (all.result as Array<{ id: string; status: string }>).map((r) => ({
                id: r.id,
                status: r.status,
              })),
            );
          all.onerror = () => reject(new Error('cannot read outbox'));
        };
      }),
  );
}

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

test.describe('O-12: a client never stays on a build older than the server', () => {
  test('updates itself on reconnect, and the unsent outbox survives it', async ({
    page,
    context,
    server,
    baseURL,
  }) => {
    const deployed = await DeployServer.mirror(page.request, baseURL!);
    try {
      deployed.deploy('A');
      await signIn(page, deployed.url);
      await waitForServiceWorkerControl(page);
      expect(await runningBuild(page)).toBe('A');

      // Make every drain fail, so the technician's entries stay genuinely
      // UNSENT across the update. Registered after `server.install`, so it
      // takes precedence over the fake server's own outbox handler.
      await page.route('**/api/v1/sync/outbox', (route) => route.abort('internetdisconnected'));

      await page.getByText('PM-2026-000431').click();
      await page.getByRole('button', { name: 'Done', exact: true }).first().click();
      await expect(page.getByText('Held on device')).toBeVisible();

      const before = await outboxRows(page);
      expect(before.length).toBeGreaterThan(0);
      expect(before.every((r) => r.status !== 'acked')).toBe(true);

      // ---- the deploy ----
      deployed.deploy('B');

      // ---- and the only thing that happens to the device: plant WiFi
      // drops and comes back. A real `online` event from a real transport
      // state change; the test never reloads the page. ----
      await context.setOffline(true);
      await page.waitForTimeout(500);
      await context.setOffline(false);

      await expect
        .poll(() => runningBuild(page), {
          timeout: 30_000,
          message: 'client never reached build B',
        })
        .toBe('B');

      // NON-NEGOTIABLE: the technician's unsent work is still there, still
      // unsent, with the same row identities it had before the update.
      const after = await outboxRows(page);
      expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
      expect(after.every((r) => r.status !== 'acked')).toBe(true);
      // And the app itself still says so, in its own words.
      await expect(page.getByText('Held on device')).toBeVisible();
    } finally {
      await deployed.close();
      void server;
    }
  });

  test('an outdated-client API rejection triggers the update path', async ({
    page,
    server,
    baseURL,
  }) => {
    const deployed = await DeployServer.mirror(page.request, baseURL!);
    try {
      deployed.deploy('A');
      await signIn(page, deployed.url);
      await waitForServiceWorkerControl(page);
      expect(await runningBuild(page)).toBe('A');

      deployed.deploy('B');

      // Exactly the shape that stranded the owner: the server refuses a
      // request because this client does not know what it now requires.
      // Slice 18 did this for real with `drawnSignature` on submit.
      await page.route('**/api/v1/jobs/*/submit', (route) =>
        route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: '/errors/validation-failed',
            title: 'Validation failed',
            status: 422,
            errors: [{ pointer: '/drawnSignature', message: 'Required' }],
          }),
        }),
      );

      await page.getByText('PM-2026-000431').click();
      await page.getByRole('button', { name: 'Done', exact: true }).first().click();
      await page.getByRole('button', { name: 'Sign and submit' }).click();
      const pad = page.getByTestId('performer-signature');
      await expect(pad).toBeVisible();
      const canvas = page.locator('.signature-pad-canvas');
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      if (!box) throw new Error('signature pad canvas has no bounding box');
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await pad.getByRole('button', { name: 'Done' }).click();

      // The rejection alone — nothing else — must carry the client forward.
      await expect
        .poll(() => runningBuild(page), {
          timeout: 30_000,
          message: 'an outdated-client rejection did not trigger the update',
        })
        .toBe('B');
    } finally {
      await deployed.close();
      void server;
    }
  });

  /**
   * PRODUCTION AS IT ACTUALLY WAS (review finding S-1) — the case that made
   * the first version of this slice a no-op on the live server.
   *
   * `docker-compose.yml` maps `VITE_APP_VERSION: ${IMAGE_TAG:-local}`,
   * `.env.example` pins `IMAGE_TAG=local`, and the droplet's deploy script
   * sourced that and built. So a genuine deploy — new `index.html`, new
   * content-hashed bundle — shipped a BYTE-IDENTICAL `/sw.js`. Measured:
   * `fe6d1732…` for two builds from different source.
   * `registration.update()` byte-compares, correctly finds no change, and the
   * client can never leave its build. Every test still passed.
   *
   * The root cause is fixed (the worker is versioned by build output now,
   * enforced by scripts/ci/assert-sw-changes-per-build.sh). This test asserts
   * the BEHAVIOUR is robust even if that ever regresses: a deploy the
   * service-worker comparison is blind to must still reach the client.
   */
  test('updates even when the deploy ships a byte-identical service worker', async ({
    page,
    server,
    baseURL,
  }) => {
    const deployed = await DeployServer.mirror(page.request, baseURL!);
    try {
      deployed.deploy('A');
      await signIn(page, deployed.url);
      await waitForServiceWorkerControl(page);
      expect(await runningBuild(page)).toBe('A');

      const swBefore = await page.evaluate(async () =>
        (await fetch('/sw.js', { cache: 'no-store' })).text(),
      );

      deployed.deploy('B-stale-worker');

      // Same worker bytes as before the deploy — the primary detector is
      // blind here, exactly as it was on form.bevorasg.com.
      const swAfter = await page.evaluate(async () =>
        (await fetch('/sw.js', { cache: 'no-store' })).text(),
      );
      expect(swAfter).toBe(swBefore);

      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

      await expect
        .poll(() => runningBuild(page), {
          timeout: 30_000,
          message:
            'a deploy with an unchanged sw.js never reached the client — this is exactly the ' +
            'production failure of review S-1',
        })
        .toBe('B');
    } finally {
      await deployed.close();
      void server;
    }
  });
});
